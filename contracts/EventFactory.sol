/// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.35;

import "./EventTicket.sol";

/**
 * @title Registry and factory for event ticketing contracts
 * @notice Deployed once by the platform. Creating an event deploys a fresh
 * EventTicket contract - each event's tickets, funds, deposits, and
 * validator authorisations are fully isolated. The platform's pricing
 * policy (fixed fee + percentage, benchmarked against Eventbrite) and the
 * sweep delay are set here at deployment, on-chain and immutable, so the
 * rules every event runs under are transparent and cannot be changed
 * quietly. The registry maps the human-friendly event id to the event's
 * contract address - the audit trail's entry point.
 */
contract EventFactory {
    address public immutable platform; // Factory deployer: fee recipient
    uint256 public immutable feeFixed; // Service fee: fixed part in Wei
    uint256 public immutable feeBps; // Service fee: percentage in basis points
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
     * @param _feeFixed Fixed part of the service fee in Wei
     * @param _feeBps Percentage part of the service fee in basis points
     * @param _sweepDelay Blocks after an event's endBlock until the
     * platform may sweep unclaimed refunds
     */
    constructor(uint256 _feeFixed, uint256 _feeBps, uint256 _sweepDelay) {
        platform = msg.sender;
        feeFixed = _feeFixed;
        feeBps = _feeBps;
        sweepDelay = _sweepDelay;
    }

    /**
     * @notice Create a new event by deploying its own EventTicket contract
     *
     * @param name Event name
     * @param capacity Total ticket supply (releasing it all is optional)
     * @param price Primary sale price in Wei (must at least cover the
     * service fee)
     * @param resaleCap Resale price cap in Wei
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
            feeFixed,
            feeBps,
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
