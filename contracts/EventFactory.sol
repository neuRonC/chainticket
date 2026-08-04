/// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.35;

import "./EventTicket.sol";

/**
 * @title Registry and factory for event ticketing contracts
 * @notice Deployed once by the platform. 
 * Creating an event deploys a fresh EventTicket contract; 
 * Each event's tickets, funds, and validator authorisations are fully isolated. 
 * The sweep delay is set here at deployment, on-chain and immutable, 
 * so the rules every event runs under are transparent and cannot be changed quietly.
 * The registry maps the human-friendly event id to the event's contract address ---
 * the audit trail's entry point.
 */
contract EventFactory {
    address public immutable platform; // Factory deployer: receives swept leftovers
    uint256 public immutable sweepDelay; // Blocks after an event's end until sweeping

    uint256 public numEvents; // Events created so far (ids start at 1)
    mapping(uint256 => address) public eventContracts; // event id => contract

    event EventCreated(
        uint256 indexed eventId,
        address indexed eventContract,
        address indexed organiser,
        string name,
        uint256 capacity,
        uint256 price,
        uint256 resaleCap,
        uint256 entryBlock,
        uint256 endBlock
    );

    /**
     * @dev The deployer becomes the platform
     * @param _sweepDelay Blocks after an event's endBlock until the platform may sweep unclaimed refunds
     */
    constructor(uint256 _sweepDelay) {
        platform = msg.sender;
        sweepDelay = _sweepDelay;
    }

    /**
     * @notice Create a new event by deploying its own EventTicket contract
     *
     * @param name Event name
     * @param capacity Total ticket supply
     * @param price Primary sale price
     * @param resaleCap Resale price cap
     * @param entryBlock Block at which entry opens (sales stop, check-in starts)
     * @param endBlock Block at which the event is over (settlement possible)
     * @return eventId Id of the new event in this registry
     * @return eventContract Address of the newly deployed contract
     */
    function createEvent(
        string memory name,
        uint256 capacity,
        uint256 price,
        uint256 resaleCap,
        uint256 entryBlock,
        uint256 endBlock
    ) external returns (uint256 eventId, address eventContract) {
        numEvents++;
        eventId = numEvents;
        EventTicket ticket = new EventTicket(
            eventId,
            msg.sender,
            platform,
            name,
            capacity,
            price,
            resaleCap,
            entryBlock,
            endBlock,
            sweepDelay
        );
        eventContract = address(ticket);
        eventContracts[eventId] = eventContract;
        emit EventCreated(
            eventId,
            eventContract,
            msg.sender,
            name,
            capacity,
            price,
            resaleCap,
            entryBlock,
            endBlock
        );
    }
}
