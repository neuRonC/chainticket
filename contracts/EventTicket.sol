/// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.35;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/**
 * @title One event's ticketing contract
 * @notice Deployed by the EventFactory, one instance per event. 
 * All timing is block-number based: 
 * entryBlock is when the gates open (check-in starts, sales stop),
 * endBlock is when the event is over. 
 * Tickets are released for sale in batches. 
 * Whoever sends a transaction pays its own gas.
 * After endBlock anyone may trigger settlement - contracts cannot auto-execute, so the platform's indexer acts as the keeper.
 * Early closure by the organiser opens full refunds for unused tickets; 
 * leftovers are sweepable by the platform after a delay.
 */
contract EventTicket is ERC721 {
    enum TicketStatus {
        Valid,
        Used
    }

    // Immutable configuration

    uint256 public immutable eventId; // Id in the factory's registry
    address public immutable organiser;
    address public immutable platform; // Receives swept leftovers
    uint256 public immutable capacity; // Maximum number of tickets
    uint256 public immutable price; // Primary sale price in Wei
    uint256 public immutable resaleCap; // Resale price cap in Wei
    uint256 public immutable entryBlock; // Gates open: check-in starts, sales stop
    uint256 public immutable endBlock; // Event over: settlement possible
    uint256 public immutable sweepDelay; // Blocks after endBlock until platform may sweep

    string public eventName;

    // State

    uint256 public released; // Tickets released for sale so far
    uint256 public numTickets; // Tickets sold so far (ids start at 1)
    uint256 public usedCount; // Tickets checked in so far
    bool public closed; // Terminal: settled or closed early
    bool public refundsOpen; // Set when closed before endBlock

    mapping(uint256 => TicketStatus) public statusOf; // ticket id => status
    mapping(uint256 => uint256) public listingPriceOf; // ticket id => resale price (0 = not listed)
    mapping(address => bool) public isValidator; // authorised gate validators
    mapping(uint256 => bytes32) public checkInCodeHash; // ticket id => hash of its check-in code

    bool private _inMarketTransfer; // Set only inside buyListed

    // Events informing contract activities (consumed by the off-chain indexer)
    event TicketsReleased(uint256 count, uint256 totalReleased);
    event ValidatorAuthorized(address indexed validator);
    event ValidatorRevoked(address indexed validator);
    event TicketPurchased(uint256 indexed ticketId, address indexed buyer, uint256 price);
    event TicketListed(uint256 indexed ticketId, uint256 price);
    event TicketUnlisted(uint256 indexed ticketId);
    event ListingSold(
        uint256 indexed ticketId,
        address indexed seller,
        address indexed buyer,
        uint256 price
    );
    event CheckInCodeSet(uint256 indexed ticketId);
    event TicketUsed(uint256 indexed ticketId, address indexed validator);
    event EventClosed(uint256 payout); // Early closure: refunds are now open
    event EventSettled(uint256 payout); // Normal end-of-event settlement
    event RefundClaimed(uint256 indexed ticketId, address indexed holder, uint256 amount);
    event LeftoverSwept(uint256 amount);

    /**
     * @notice Only the event organiser can call
     */
    modifier onlyOrganiser() {
        require(msg.sender == organiser, "Only the organiser can call");
        _;
    }

    /**
     * @notice Only an authorised validator can call
     */
    modifier onlyValidator() {
        require(isValidator[msg.sender], "Only an authorised validator can call");
        _;
    }

    /**
     * @notice Only while the event is not closed
     */
    modifier notClosed() {
        require(!closed, "Event is closed");
        _;
    }

    /**
     * @dev Called by the EventFactory. 
     * The organiser is automatically an authorised validator (and can therefore never hold a ticket)
     */
    constructor(
        uint256 _eventId,
        address _organiser,
        address _platform,
        string memory _name,
        uint256 _capacity,
        uint256 _price,
        uint256 _resaleCap,
        uint256 _entryBlock,
        uint256 _endBlock,
        uint256 _sweepDelay
    ) ERC721(_name, "TICKET") {
        require(_capacity > 0, "Capacity must be positive");
        require(block.number < _entryBlock, "Entry block must be in the future");
        require(_entryBlock < _endBlock, "End block must be after entry");
        eventId = _eventId;
        organiser = _organiser;
        platform = _platform;
        eventName = _name;
        capacity = _capacity;
        price = _price;
        resaleCap = _resaleCap;
        entryBlock = _entryBlock;
        endBlock = _endBlock;
        sweepDelay = _sweepDelay;
        isValidator[_organiser] = true;
        emit ValidatorAuthorized(_organiser);
    }

    // Organiser: batch release, validators, early closure

    /**
     * @notice Release `count` more tickets for sale (batch sales, FR1).
     * Releasing is never an obligation to fill the capacity ---
     * the chain only guarantees capacity and released numbers are public
     *
     * @param count Number of tickets to release (positive)
     */
    function releaseTickets(uint256 count) external onlyOrganiser notClosed {
        require(count > 0, "Count must be positive");
        require(released + count <= capacity, "Exceeds capacity");
        require(block.number < entryBlock, "Sales are over");
        released += count;
        emit TicketsReleased(count, released);
    }

    /**
     * @notice Authorise a validator; 
     * allowed until the event ends so the organiser can react to staffing problems mid-event
     *
     * @param validator Account to authorise
     */
    function authorizeValidator(address validator) external onlyOrganiser notClosed {
        require(block.number < endBlock, "Event is over");
        require(balanceOf(validator) == 0, "Ticket holders cannot be validators");
        isValidator[validator] = true;
        emit ValidatorAuthorized(validator);
    }

    /**
     * @notice Revoke a validator's authorisation
     *
     * @param validator Account to revoke
     */
    function revokeValidator(address validator) external onlyOrganiser notClosed {
        require(block.number < endBlock, "Event is over");
        require(validator != organiser, "The organiser stays a validator");
        isValidator[validator] = false;
        emit ValidatorRevoked(validator);
    }

    /**
     * @notice Close the event early (before endBlock), opening refunds.
     * Before entry: buyers of every ticket can claim a full refund.
     * During the event: revenue of already-used tickets settles to the organiser now; 
     * Unused tickets can claim a full refund.
     */
    function closeEvent() external onlyOrganiser notClosed {
        require(block.number < endBlock, "Event is over - settlement is automatic");
        closed = true;
        refundsOpen = true;
        uint256 payout = 0;
        if (block.number >= entryBlock) {
            payout = usedCount * price;
            if (payout > 0) {
                (bool ok, ) = payable(organiser).call{value: payout}("");
                require(ok, "Payout transfer failed");
            }
        }
        emit EventClosed(payout);
    }

    // Anyone: settlement after the event ends (keeper pattern)

    /**
     * @notice Settle a normally-ended event: the organiser receives all revenue; unused tickets are expired.
     * Callable by anyone - contracts cannot auto-execute, so the platform's indexer triggers this the moment endBlock passes.
     */
    function settle() external notClosed {
        require(block.number >= endBlock, "Event is not over yet");
        closed = true;
        uint256 payout = address(this).balance;
        if (payout > 0) {
            (bool ok, ) = payable(organiser).call{value: payout}("");
            require(ok, "Payout transfer failed");
        }
        emit EventSettled(payout);
    }

    // Users: primary sale, resale market, refunds

    /**
     * @notice Buy a released ticket in the primary sale
     *
     * @return Id of the purchased ticket
     */
    function buy() external payable notClosed returns (uint256) {
        require(block.number < entryBlock, "Sales are over");
        require(numTickets < released, "No tickets on sale");
        require(msg.value == price, "Incorrect payment");
        numTickets++;
        uint256 ticketId = numTickets;
        _safeMint(msg.sender, ticketId);
        emit TicketPurchased(ticketId, msg.sender, price);
        return ticketId;
    }

    /**
     * @notice List a ticket on the resale market (FR2), until entry opens.
     * The asking price is capped (anti-scalping)
     *
     * @param ticketId Ticket to list
     * @param askingPrice Resale price in Wei
     */
    function listForResale(uint256 ticketId, uint256 askingPrice) external notClosed {
        require(block.number < entryBlock, "Sales are over");
        require(ownerOf(ticketId) == msg.sender, "Only the ticket owner can list");
        require(statusOf[ticketId] == TicketStatus.Valid, "Used tickets cannot be listed");
        require(listingPriceOf[ticketId] == 0, "Ticket is already listed");
        require(askingPrice <= resaleCap, "Price exceeds the resale cap");
        listingPriceOf[ticketId] = askingPrice;
        emit TicketListed(ticketId, askingPrice);
    }

    /**
     * @notice Take a ticket off the resale market
     *
     * @param ticketId Ticket to unlist
     */
    function unlist(uint256 ticketId) external {
        require(ownerOf(ticketId) == msg.sender, "Only the ticket owner can unlist");
        require(listingPriceOf[ticketId] != 0, "Ticket is not listed");
        listingPriceOf[ticketId] = 0;
        emit TicketUnlisted(ticketId);
    }

    /**
     * @notice Buy a listed ticket, until entry opens. The seller receives the asking price in full.
     *
     * @param ticketId Listed ticket to buy
     */
    function buyListed(uint256 ticketId) external payable notClosed {
        require(block.number < entryBlock, "Sales are over");
        uint256 askingPrice = listingPriceOf[ticketId];
        require(askingPrice != 0, "Ticket is not listed");
        require(msg.value == askingPrice, "Incorrect payment");
        address seller = ownerOf(ticketId);
        require(seller != msg.sender, "Cannot buy your own listing");

        listingPriceOf[ticketId] = 0;
        _inMarketTransfer = true;
        _transfer(seller, msg.sender, ticketId);
        _inMarketTransfer = false;

        emit ListingSold(ticketId, seller, msg.sender, askingPrice);
        (bool ok, ) = payable(seller).call{value: askingPrice}("");
        require(ok, "Payment to the seller failed");
    }

    /**
     * @notice Claim a full refund after an early closure
     *
     * @param ticketId Ticket to refund
     */
    function claimRefund(uint256 ticketId) external {
        require(closed && refundsOpen, "Refunds are not open");
        require(ownerOf(ticketId) == msg.sender, "Only the ticket owner can claim");
        require(statusOf[ticketId] == TicketStatus.Valid, "Used tickets cannot be refunded");
        listingPriceOf[ticketId] = 0;
        _burn(ticketId);
        (bool ok, ) = payable(msg.sender).call{value: price}("");
        require(ok, "Refund transfer failed");
        emit RefundClaimed(ticketId, msg.sender, price);
    }

    /**
     * @notice Set (or replace) the ticket's check-in code, as a hash - the commit half of check-in's commit-reveal scheme.
     * Simulates handing the holder a QR code: only whoever holds this hash's preimage can pass `markUsed`.
     * Cleared on every resale (see `_update`), so a new owner must set their own before they can check in.
     *
     * @param ticketId Ticket to set the code for
     * @param codeHash keccak256 of the plaintext code
     */
    function setCheckInCode(uint256 ticketId, bytes32 codeHash) external notClosed {
        require(ownerOf(ticketId) == msg.sender, "Only the ticket owner can set the code");
        require(statusOf[ticketId] == TicketStatus.Valid, "Used tickets cannot be recoded");
        checkInCodeHash[ticketId] = codeHash;
        emit CheckInCodeSet(ticketId);
    }

    // Validators: gate check-in during the event window (FR3)

    /**
     * @notice Mark a ticket as used at the gate
     * Only during the event window (entry to end)
     *
     * @param ticketId Ticket to mark as used
     * @param code Plaintext check-in code, as shown by the holder
     */
    function markUsed(uint256 ticketId, string calldata code) external onlyValidator notClosed {
        require(block.number >= entryBlock, "Entry has not opened yet");
        require(block.number < endBlock, "Event is over");
        _requireOwned(ticketId);
        require(statusOf[ticketId] == TicketStatus.Valid, "Ticket is already used");
        bytes32 hash = checkInCodeHash[ticketId];
        require(hash != bytes32(0), "No check-in code set");
        require(keccak256(abi.encodePacked(code)) == hash, "Wrong check-in code");
        statusOf[ticketId] = TicketStatus.Used;
        usedCount++;
        if (listingPriceOf[ticketId] != 0) {
            listingPriceOf[ticketId] = 0;
            emit TicketUnlisted(ticketId);
        }
        emit TicketUsed(ticketId, msg.sender);
    }

    // Platform: sweep unclaimed leftovers after refunds

    /**
     * @notice After an early closure, remaining refunds can be swept by the platform once the sweep delay has passed after endBlock.
     */
    function sweepLeftovers() external {
        require(msg.sender == platform, "Only the platform can sweep");
        require(closed && refundsOpen, "Nothing to sweep");
        require(block.number >= endBlock + sweepDelay, "Sweep delay not reached");
        uint256 amount = address(this).balance;
        (bool ok, ) = payable(platform).call{value: amount}("");
        require(ok, "Sweep transfer failed");
        emit LeftoverSwept(amount);
    }

    // Internals

    /**
     * @dev ERC-721 transfer hook, the single acquisition checkpoint:
     * transfers only through the resale market, one ticket per address,
     * and validators (including the organiser) may not acquire tickets.
     * A resold ticket's check-in code is cleared - the new owner sets their own.
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            require(_inMarketTransfer, "Tickets change hands only via the resale market");
            checkInCodeHash[tokenId] = bytes32(0);
        }
        if (to != address(0)) {
            require(balanceOf(to) == 0, "Each address may hold only one ticket");
            require(!isValidator[to], "Validators cannot hold this event's tickets");
        }
        return super._update(to, tokenId, auth);
    }
}
