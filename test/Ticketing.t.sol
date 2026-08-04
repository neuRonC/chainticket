// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.35;

import "forge-std/Test.sol";
import "../contracts/EventFactory.sol";
import "../contracts/EventTicket.sol";

/// @title Unit tests for the EventFactory / EventTicket
contract TicketingTest is Test {
    EventFactory public factory;
    EventTicket public evt;

    address platform;
    address organiser;
    address validator;
    address alice; // buyer
    address bob; // resale buyer
    address mallory; // unauthorised account

    uint256 constant PRICE = 0.05 ether;
    uint256 constant CAPACITY = 3;
    uint256 constant CAP = PRICE; // resale at most the face price
    uint256 constant SWEEP_DELAY = 10;
    uint256 constant ENTRY = 100; // entry block of the test event
    uint256 constant END = 200; // end block of the test event

    /// @notice Sets up the testing environment before each test.
    function setUp() public {
        platform = makeAddr("platform");
        organiser = makeAddr("organiser");
        validator = makeAddr("validator");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        mallory = makeAddr("mallory");
        vm.deal(organiser, 10 ether);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        vm.deal(mallory, 1 ether);

        vm.prank(platform);
        factory = new EventFactory(SWEEP_DELAY);

        vm.roll(1);
        vm.prank(organiser);
        (, address eventContract) = factory.createEvent(
            "Moonlight Concert",
            CAPACITY,
            PRICE,
            CAP,
            ENTRY,
            END
        );
        evt = EventTicket(eventContract);
    }

    // HELPER SETUP FUNCTIONS

    /// @dev Releases `n` tickets.
    function helper_release(uint256 n) internal {
        vm.prank(organiser);
        evt.releaseTickets(n);
    }

    /// @dev Releases 3 tickets and has Alice buy ticket #1.
    function helper_releaseAndBuy() internal returns (uint256 ticketId) {
        helper_release(3);
        vm.prank(alice);
        ticketId = evt.buy{value: PRICE}();
    }

    // FACTORY AND DEPLOYMENT WIRING

    /// @notice Verifies the factory registers the event and wires everything.
    function test_factoryCreatesEvent() public view {
        assertEq(factory.platform(), platform, "Platform is the factory deployer");
        assertEq(factory.eventContracts(1), address(evt), "Registry address mismatch");
        assertEq(evt.organiser(), organiser, "Organiser should be the creator");
        assertEq(evt.platform(), platform, "Platform passed through");
        assertEq(evt.entryBlock(), ENTRY, "Entry block mismatch");
        assertEq(evt.endBlock(), END, "End block mismatch");
        assertTrue(evt.isValidator(organiser), "Organiser is auto-validator");
    }

    /// @notice A second event gets its own id and contract, isolated from the first.
    function test_factoryMultipleEvents() public {
        vm.prank(alice); // a different organiser this time
        (uint256 eventId2, address eventContract2) = factory.createEvent(
            "Second Show",
            5,
            0.1 ether,
            0.1 ether,
            ENTRY + 1,
            END + 1
        );

        assertEq(factory.numEvents(), 2, "Registry counts both events");
        assertEq(eventId2, 2, "Second event gets the next id");
        assertEq(factory.eventContracts(2), eventContract2, "Second event registered");
        assertTrue(eventContract2 != address(evt), "Distinct contract from the first event");

        EventTicket evt2 = EventTicket(eventContract2);
        assertEq(evt2.organiser(), alice, "Second event's organiser is independent");
        assertEq(evt2.price(), 0.1 ether, "Second event's price is independent");
        assertEq(evt2.capacity(), 5, "Second event's capacity is independent");

        // The first event's own registration is untouched by the second.
        assertEq(evt.organiser(), organiser, "First event's organiser unaffected");
        assertEq(factory.eventContracts(1), address(evt), "First event's registry entry unaffected");
    }

    /// @notice Reverts on invalid timing or capacity at creation.
    function test_createEventFailure_badParams() public {
        vm.roll(50);
        vm.expectRevert("Capacity must be positive");
        factory.createEvent("X", 0, PRICE, CAP, 100, 200);
        vm.expectRevert("Entry block must be in the future");
        factory.createEvent("X", 1, PRICE, CAP, 50, 200);
        vm.expectRevert("End block must be after entry");
        factory.createEvent("X", 1, PRICE, CAP, 100, 100);
    }

    // BATCH RELEASE (FR1)

    /// @notice The organiser releases batches.
    function test_releaseTickets() public {
        helper_release(2);
        assertEq(evt.released(), 2, "Two tickets released");
        helper_release(1); // a second batch
        assertEq(evt.released(), 3, "Batches accumulate");
    }

    /// @notice Reverts beyond capacity, after entry, or from a non-organiser.
    function test_releaseFailures() public {
        vm.prank(organiser);
        vm.expectRevert("Count must be positive");
        evt.releaseTickets(0);

        vm.prank(organiser);
        vm.expectRevert("Exceeds capacity");
        evt.releaseTickets(4);

        vm.prank(mallory);
        vm.expectRevert("Only the organiser can call");
        evt.releaseTickets(1);

        vm.roll(ENTRY);
        vm.prank(organiser);
        vm.expectRevert("Sales are over");
        evt.releaseTickets(1);
    }

    // PRIMARY SALE

    /// @notice A user buys a released ticket; the full price stays in escrow.
    function test_buy() public {
        helper_release(1);
        vm.prank(alice);
        uint256 ticketId = evt.buy{value: PRICE}();

        assertEq(evt.ownerOf(ticketId), alice, "Alice owns the ticket");
        assertEq(address(evt).balance, PRICE, "Escrow keeps the full price");
    }

    /// @notice Reverts without released stock, after entry, on wrong payment.
    function test_buyFailures() public {
        vm.prank(alice);
        vm.expectRevert("No tickets on sale");
        evt.buy{value: PRICE}();

        helper_release(1);
        vm.prank(alice);
        vm.expectRevert("Incorrect payment");
        evt.buy{value: PRICE - 1}();

        vm.roll(ENTRY);
        vm.prank(alice);
        vm.expectRevert("Sales are over");
        evt.buy{value: PRICE}();
    }

    /// @notice One ticket per address; validators cannot buy.
    function test_buyFailure_fairnessRules() public {
        helper_release(3);
        vm.startPrank(alice);
        evt.buy{value: PRICE}();
        vm.expectRevert("Each address may hold only one ticket");
        evt.buy{value: PRICE}();
        vm.stopPrank();

        vm.prank(organiser);
        evt.authorizeValidator(validator);
        vm.deal(validator, 1 ether);
        vm.prank(validator);
        vm.expectRevert("Validators cannot hold this event's tickets");
        evt.buy{value: PRICE}();

        vm.deal(organiser, 1 ether);
        vm.prank(organiser); // organiser is auto-validator
        vm.expectRevert("Validators cannot hold this event's tickets");
        evt.buy{value: PRICE}();
    }

    // RESALE MARKET

    /// @notice List and buy: the seller receives the full asking price.
    function test_resale() public {
        uint256 ticketId = helper_releaseAndBuy();
        vm.prank(alice);
        evt.listForResale(ticketId, PRICE);

        uint256 aliceBefore = alice.balance;
        vm.prank(bob);
        evt.buyListed{value: PRICE}(ticketId);

        assertEq(evt.ownerOf(ticketId), bob, "Bob owns the ticket");
        assertEq(alice.balance, aliceBefore + PRICE, "Seller got the full asking price");
    }

    /// @notice Listing failures: cap, ownership, raw transfers.
    function test_listFailures() public {
        uint256 ticketId = helper_releaseAndBuy();

        vm.prank(alice);
        vm.expectRevert("Price exceeds the resale cap");
        evt.listForResale(ticketId, PRICE + 1);

        vm.prank(mallory);
        vm.expectRevert("Only the ticket owner can list");
        evt.listForResale(ticketId, PRICE);

        vm.prank(alice);
        evt.listForResale(ticketId, PRICE);
        vm.prank(alice);
        vm.expectRevert("Ticket is already listed");
        evt.listForResale(ticketId, PRICE);

        vm.prank(alice);
        vm.expectRevert("Tickets change hands only via the resale market");
        evt.transferFrom(alice, bob, ticketId);
    }

    /// @notice Unlisting clears the price; only the owner can, and only if listed.
    function test_unlistRules() public {
        uint256 ticketId = helper_releaseAndBuy();
        vm.prank(alice);
        evt.listForResale(ticketId, PRICE);

        vm.prank(mallory);
        vm.expectRevert("Only the ticket owner can unlist");
        evt.unlist(ticketId);

        vm.prank(alice);
        evt.unlist(ticketId);
        assertEq(evt.listingPriceOf(ticketId), 0, "Listing cleared");

        vm.prank(alice);
        vm.expectRevert("Ticket is not listed");
        evt.unlist(ticketId);
    }

    /// @notice Buying a listed ticket rejects a non-listing, self-purchase, or wrong amount.
    function test_buyListedFailures() public {
        uint256 ticketId = helper_releaseAndBuy();

        vm.prank(bob);
        vm.expectRevert("Ticket is not listed");
        evt.buyListed{value: PRICE}(ticketId);

        vm.prank(alice);
        evt.listForResale(ticketId, PRICE);

        vm.prank(alice);
        vm.expectRevert("Cannot buy your own listing");
        evt.buyListed{value: PRICE}(ticketId);

        vm.prank(bob);
        vm.expectRevert("Incorrect payment");
        evt.buyListed{value: PRICE - 1}(ticketId);
    }

    /// @notice Listings and purchases stop when entry opens.
    function test_marketClosesAtEntry() public {
        uint256 ticketId = helper_releaseAndBuy();
        vm.prank(alice);
        evt.listForResale(ticketId, PRICE);

        vm.roll(ENTRY);
        vm.prank(bob);
        vm.expectRevert("Sales are over");
        evt.buyListed{value: PRICE}(ticketId);
    }

    // VALIDATION WINDOW (FR3)

    /// @dev Sets a ticket's check-in code as `owner` and returns the plaintext.
    function helper_setCode(uint256 ticketId, address owner) internal returns (string memory code) {
        code = "secret";
        vm.prank(owner);
        evt.setCheckInCode(ticketId, keccak256(abi.encodePacked(code)));
    }

    /// @notice Check-in works only inside [entry, end).
    function test_markUsedWindow() public {
        uint256 ticketId = helper_releaseAndBuy();
        string memory code = helper_setCode(ticketId, alice);
        vm.prank(organiser);
        evt.authorizeValidator(validator);

        vm.prank(validator);
        vm.expectRevert("Entry has not opened yet");
        evt.markUsed(ticketId, code);

        vm.roll(ENTRY);
        vm.prank(validator);
        evt.markUsed(ticketId, code);
        assertEq(evt.usedCount(), 1, "Used count incremented");

        vm.roll(END);
        vm.prank(validator);
        vm.expectRevert("Event is over");
        evt.markUsed(ticketId, code);
    }

    // CHECK-IN CODE

    /// @notice Only the current owner can set a code, and only on a valid ticket.
    function test_setCheckInCodeRules() public {
        uint256 ticketId = helper_releaseAndBuy();
        bytes32 hash = keccak256(abi.encodePacked("secret"));

        vm.prank(mallory);
        vm.expectRevert("Only the ticket owner can set the code");
        evt.setCheckInCode(ticketId, hash);

        vm.prank(alice);
        evt.setCheckInCode(ticketId, hash);
        assertEq(evt.checkInCodeHash(ticketId), hash, "Hash stored");

        vm.prank(organiser);
        evt.authorizeValidator(validator);
        vm.roll(ENTRY);
        vm.prank(validator);
        evt.markUsed(ticketId, "secret");

        vm.prank(alice);
        vm.expectRevert("Used tickets cannot be recoded");
        evt.setCheckInCode(ticketId, keccak256(abi.encodePacked("new")));
    }

    /// @notice markUsed rejects a missing or wrong code.
    function test_markUsedFailure_badCode() public {
        uint256 ticketId = helper_releaseAndBuy();
        vm.prank(organiser);
        evt.authorizeValidator(validator);
        vm.roll(ENTRY);

        vm.prank(validator);
        vm.expectRevert("No check-in code set");
        evt.markUsed(ticketId, "secret");

        vm.prank(alice);
        evt.setCheckInCode(ticketId, keccak256(abi.encodePacked("secret")));

        vm.prank(validator);
        vm.expectRevert("Wrong check-in code");
        evt.markUsed(ticketId, "guess");
    }

    /// @notice Only an authorised validator can check in a ticket.
    function test_markUsedFailure_notValidator() public {
        uint256 ticketId = helper_releaseAndBuy();
        string memory code = helper_setCode(ticketId, alice);
        vm.roll(ENTRY);

        vm.prank(mallory);
        vm.expectRevert("Only an authorised validator can call");
        evt.markUsed(ticketId, code);
    }

    /// @notice A ticket cannot be checked in twice.
    function test_markUsedFailure_alreadyUsed() public {
        uint256 ticketId = helper_releaseAndBuy();
        string memory code = helper_setCode(ticketId, alice);
        vm.roll(ENTRY);
        vm.prank(organiser);
        evt.markUsed(ticketId, code);

        vm.prank(organiser);
        vm.expectRevert("Ticket is already used");
        evt.markUsed(ticketId, code);
    }

    /// @notice Checking in a listed ticket automatically pulls it off the market.
    function test_markUsedUnlistsAListedTicket() public {
        uint256 ticketId = helper_releaseAndBuy();
        string memory code = helper_setCode(ticketId, alice);
        vm.prank(alice);
        evt.listForResale(ticketId, PRICE);
        vm.roll(ENTRY);

        vm.prank(organiser);
        evt.markUsed(ticketId, code);

        assertEq(evt.listingPriceOf(ticketId), 0, "Auto-unlisted on check-in");
    }

    /// @notice A resale clears the previous owner's code; the new owner sets their own.
    function test_checkInCodeClearedOnResale() public {
        uint256 ticketId = helper_releaseAndBuy();
        vm.prank(alice);
        evt.setCheckInCode(ticketId, keccak256(abi.encodePacked("secret")));

        vm.prank(alice);
        evt.listForResale(ticketId, PRICE);
        vm.prank(bob);
        evt.buyListed{value: PRICE}(ticketId);

        assertEq(evt.checkInCodeHash(ticketId), bytes32(0), "Code cleared on transfer");

        vm.prank(organiser);
        evt.authorizeValidator(validator);
        vm.roll(ENTRY);
        vm.prank(validator);
        vm.expectRevert("No check-in code set");
        evt.markUsed(ticketId, "secret"); // Alice's old code no longer works

        string memory code = helper_setCode(ticketId, bob);
        vm.prank(validator);
        evt.markUsed(ticketId, code);
        assertEq(evt.usedCount(), 1, "Bob's own code checks in fine");
    }

    /// @notice Validators can be authorised until the end, but never a holder.
    function test_authorizeValidatorRules() public {
        uint256 ticketId = helper_releaseAndBuy();
        ticketId; // silence unused

        vm.roll(ENTRY + 10); // mid-event staffing fix is allowed
        vm.prank(organiser);
        evt.authorizeValidator(validator);
        assertTrue(evt.isValidator(validator));

        vm.prank(organiser);
        evt.revokeValidator(validator);
        assertFalse(evt.isValidator(validator), "Revoked");

        vm.prank(organiser);
        vm.expectRevert("Ticket holders cannot be validators");
        evt.authorizeValidator(alice);

        vm.prank(organiser);
        vm.expectRevert("The organiser stays a validator");
        evt.revokeValidator(organiser);

        vm.roll(END);
        vm.prank(organiser);
        vm.expectRevert("Event is over");
        evt.authorizeValidator(mallory);

        vm.prank(organiser);
        vm.expectRevert("Event is over");
        evt.revokeValidator(validator);
    }

    /// @notice Only the organiser can authorise, revoke, or close.
    function test_organiserOnlyGuards() public {
        vm.prank(mallory);
        vm.expectRevert("Only the organiser can call");
        evt.authorizeValidator(mallory);

        vm.prank(mallory);
        vm.expectRevert("Only the organiser can call");
        evt.revokeValidator(organiser);

        vm.prank(mallory);
        vm.expectRevert("Only the organiser can call");
        evt.closeEvent();
    }

    // EARLY CLOSURE AND REFUNDS

    /// @notice Closing before entry: no payout, every ticket refundable.
    function test_closeBeforeEntry() public {
        uint256 ticketId = helper_releaseAndBuy();
        uint256 organiserBefore = organiser.balance;
        vm.prank(organiser);
        evt.closeEvent();

        assertTrue(evt.refundsOpen(), "Refunds open");
        assertEq(organiser.balance, organiserBefore, "No payout before entry");

        vm.prank(mallory);
        vm.expectRevert("Only the ticket owner can claim");
        evt.claimRefund(ticketId);

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        evt.claimRefund(ticketId);
        assertEq(alice.balance, aliceBefore + PRICE, "Full face price refunded");

        vm.prank(alice);
        vm.expectRevert(); // burned: ownerOf reverts
        evt.claimRefund(ticketId);
    }

    /// @notice Closing mid-event: used revenue settles now, unused refundable.
    function test_closeMidEvent() public {
        helper_release(3);
        vm.prank(alice);
        uint256 t1 = evt.buy{value: PRICE}();
        vm.prank(bob);
        uint256 t2 = evt.buy{value: PRICE}();

        vm.roll(ENTRY);
        string memory code = helper_setCode(t1, alice);
        vm.prank(organiser);
        evt.markUsed(t1, code); // alice attended

        uint256 organiserBefore = organiser.balance;
        vm.prank(organiser);
        evt.closeEvent();
        assertEq(
            organiser.balance,
            organiserBefore + PRICE,
            "Used ticket's revenue settled to the organiser"
        );

        vm.prank(bob);
        evt.claimRefund(t2); // unused: full refund

        vm.prank(alice);
        vm.expectRevert("Used tickets cannot be refunded");
        evt.claimRefund(t1);
    }

    /// @notice A closed event accepts no sales, listings, or check-ins.
    function test_closedFreezesEverything() public {
        uint256 ticketId = helper_releaseAndBuy();
        vm.prank(organiser);
        evt.closeEvent();

        vm.prank(bob);
        vm.expectRevert("Event is closed");
        evt.buy{value: PRICE}();

        vm.prank(alice);
        vm.expectRevert("Event is closed");
        evt.listForResale(ticketId, PRICE);

        vm.prank(alice);
        vm.expectRevert("Event is closed");
        evt.setCheckInCode(ticketId, keccak256(abi.encodePacked("x")));

        vm.prank(organiser);
        vm.expectRevert("Event is closed");
        evt.releaseTickets(1);

        vm.prank(organiser);
        vm.expectRevert("Event is closed");
        evt.closeEvent();

        vm.roll(ENTRY);
        vm.prank(organiser);
        vm.expectRevert("Event is closed");
        evt.markUsed(ticketId, "x");
    }

    /// @notice After endBlock anyone settles; the organiser receives all revenue; closing is then blocked.
    function test_settle() public {
        helper_releaseAndBuy();

        vm.expectRevert("Event is not over yet");
        evt.settle();

        vm.roll(END);
        uint256 organiserBefore = organiser.balance;
        uint256 expected = address(evt).balance;
        vm.prank(mallory); // literally anyone
        evt.settle();
        assertEq(organiser.balance, organiserBefore + expected, "Organiser got everything");
        assertEq(address(evt).balance, 0, "Contract emptied");
        assertTrue(evt.closed(), "Settled = closed");

        vm.prank(mallory);
        vm.expectRevert("Event is closed");
        evt.settle();
    }

    /// @notice The organiser cannot use closeEvent after the end.
    function test_closeAfterEndReverts() public {
        vm.roll(END);
        vm.prank(organiser);
        vm.expectRevert("Event is over - settlement is automatic");
        evt.closeEvent();
    }

    // PLATFORM SWEEP

    /// @notice Unclaimed refunds are sweepable by the platform after the delay.
    function test_sweepLeftovers() public {
        helper_releaseAndBuy();
        vm.prank(organiser);
        evt.closeEvent(); // refunds open, alice never claims

        vm.prank(platform);
        vm.expectRevert("Sweep delay not reached");
        evt.sweepLeftovers();

        vm.roll(END + SWEEP_DELAY);
        vm.prank(mallory);
        vm.expectRevert("Only the platform can sweep");
        evt.sweepLeftovers();

        uint256 leftovers = address(evt).balance;
        vm.prank(platform);
        evt.sweepLeftovers();
        assertEq(platform.balance, leftovers, "Platform swept the leftovers");
    }

    /// @notice A normally settled event has nothing to sweep.
    function test_sweepFailure_settledEvent() public {
        helper_releaseAndBuy();
        vm.roll(END + SWEEP_DELAY);
        evt.settle();
        vm.prank(platform);
        vm.expectRevert("Nothing to sweep");
        evt.sweepLeftovers();
    }
}
