// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.35;

import "forge-std/Test.sol";
import "../contracts/EventFactory.sol";
import "../contracts/EventTicket.sol";

/// @title Unit tests for the EventFactory / EventTicket pair
/// @dev Arrange-Act-Assert; block-number timing driven with vm.roll
contract EventTicketTest is Test {
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
    uint256 constant FEE_FIXED = 0.0004 ether;
    uint256 constant FEE_BPS = 500; // 5%
    uint256 constant SWEEP_DELAY = 10;
    uint256 constant ENTRY = 100; // entry block of the test event
    uint256 constant END = 200; // end block of the test event

    uint256 FEE; // service fee on the face price
    uint256 DEPOSIT; // per-ticket release deposit

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
        factory = new EventFactory(FEE_FIXED, FEE_BPS, SWEEP_DELAY);

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
        FEE = evt.feeOn(PRICE);
        DEPOSIT = evt.depositPerTicket();
    }

    // HELPER SETUP FUNCTIONS

    /// @dev Releases `n` tickets with the correct deposit.
    function helper_release(uint256 n) internal {
        vm.prank(organiser);
        evt.releaseTickets{value: n * DEPOSIT}(n);
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

    /// @notice Reverts on invalid timing or capacity at creation.
    function test_createEventFailure_badParams() public {
        vm.roll(50);
        vm.expectRevert("Capacity must be positive");
        factory.createEvent("X", 0, PRICE, CAP, 100, 200);
        vm.expectRevert("Entry block must be in the future");
        factory.createEvent("X", 1, PRICE, CAP, 50, 200);
        vm.expectRevert("End block must be after entry");
        factory.createEvent("X", 1, PRICE, CAP, 100, 100);
        vm.expectRevert("Price below the service fee");
        factory.createEvent("X", 1, FEE_FIXED, CAP, 100, 200); // cannot cover its own fee
    }

    // BATCH RELEASE (FR1)

    /// @notice The organiser releases batches with the exact deposit.
    function test_releaseTickets() public {
        helper_release(2);
        assertEq(evt.released(), 2, "Two tickets released");
        assertEq(evt.gasFloat(), 2 * DEPOSIT, "Deposit recorded as float");
        helper_release(1); // a second batch
        assertEq(evt.released(), 3, "Batches accumulate");
    }

    /// @notice Reverts beyond capacity, with a wrong deposit, after entry,
    /// or from a non-organiser.
    function test_releaseFailures() public {
        vm.prank(organiser);
        vm.expectRevert("Exceeds capacity");
        evt.releaseTickets{value: 4 * DEPOSIT}(4);

        vm.prank(organiser);
        vm.expectRevert("Incorrect deposit");
        evt.releaseTickets{value: 1}(1);

        vm.prank(mallory);
        vm.expectRevert("Only the organiser can call");
        evt.releaseTickets{value: DEPOSIT}(1);

        vm.roll(ENTRY);
        vm.prank(organiser);
        vm.expectRevert("Sales are over");
        evt.releaseTickets{value: DEPOSIT}(1);
    }

    // PRIMARY SALE

    /// @notice A user buys a released ticket; the fee leaves the escrow.
    function test_buy() public {
        helper_release(1);
        vm.prank(alice);
        uint256 ticketId = evt.buy{value: PRICE}();

        assertEq(evt.ownerOf(ticketId), alice, "Alice owns the ticket");
        // Zero gas price in tests: the whole fee goes to the platform.
        assertEq(platform.balance, FEE, "Platform received the fee");
        assertEq(
            address(evt).balance,
            PRICE - FEE + DEPOSIT,
            "Escrow keeps price minus fee, plus the deposit"
        );
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

    /// @notice One ticket per address; validators (incl. organiser) cannot buy.
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

    /// @notice List and buy: seller receives asking price minus the fee.
    function test_resale() public {
        uint256 ticketId = helper_releaseAndBuy();
        vm.prank(alice);
        evt.listForResale(ticketId, PRICE);

        uint256 aliceBefore = alice.balance;
        uint256 platformBefore = platform.balance;
        vm.prank(bob);
        evt.buyListed{value: PRICE}(ticketId);

        uint256 askFee = evt.feeOn(PRICE);
        assertEq(evt.ownerOf(ticketId), bob, "Bob owns the ticket");
        assertEq(alice.balance, aliceBefore + PRICE - askFee, "Seller got price minus fee");
        assertEq(platform.balance, platformBefore + askFee, "Platform got the resale fee");
    }

    /// @notice Listing failures: cap, fee floor, ownership, raw transfers.
    function test_listFailures() public {
        uint256 ticketId = helper_releaseAndBuy();

        vm.prank(alice);
        vm.expectRevert("Price exceeds the resale cap");
        evt.listForResale(ticketId, PRICE + 1);

        vm.prank(alice);
        vm.expectRevert("Price must cover the service fee");
        evt.listForResale(ticketId, FEE_FIXED); // below its own fee

        vm.prank(mallory);
        vm.expectRevert("Only the ticket owner can list");
        evt.listForResale(ticketId, PRICE);

        vm.prank(alice);
        vm.expectRevert("Tickets change hands only via the resale market");
        evt.transferFrom(alice, bob, ticketId);
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

    /// @notice Check-in works only inside [entry, end).
    function test_markUsedWindow() public {
        uint256 ticketId = helper_releaseAndBuy();
        vm.prank(organiser);
        evt.authorizeValidator(validator);

        vm.prank(validator);
        vm.expectRevert("Entry has not opened yet");
        evt.markUsed(ticketId);

        vm.roll(ENTRY);
        vm.prank(validator);
        evt.markUsed(ticketId);
        assertEq(evt.usedCount(), 1, "Used count incremented");

        vm.prank(validator);
        evt.revokeValidation(ticketId);
        assertEq(evt.usedCount(), 0, "Used count decremented");

        vm.roll(END);
        vm.prank(validator);
        vm.expectRevert("Event is over");
        evt.markUsed(ticketId);
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
        vm.expectRevert("Ticket holders cannot be validators");
        evt.authorizeValidator(alice);

        vm.roll(END);
        vm.prank(organiser);
        vm.expectRevert("Event is over");
        evt.authorizeValidator(mallory);

        vm.prank(organiser);
        vm.expectRevert("The organiser stays a validator");
        evt.revokeValidator(organiser);
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
        vm.prank(organiser);
        evt.markUsed(t1); // alice attended

        uint256 organiserBefore = organiser.balance;
        vm.prank(organiser);
        evt.closeEvent();
        assertEq(
            organiser.balance,
            organiserBefore + (PRICE - FEE),
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

        vm.roll(ENTRY);
        vm.prank(organiser);
        vm.expectRevert("Event is closed");
        evt.markUsed(ticketId);
    }

    // SETTLEMENT (keeper pattern)

    /// @notice After endBlock anyone settles; the organiser receives
    /// revenue plus the deposit remainder; closing is then blocked.
    function test_settle() public {
        helper_releaseAndBuy();

        vm.expectRevert("Event is not over yet");
        evt.settle();

        vm.roll(END);
        uint256 organiserBefore = organiser.balance;
        uint256 expected = address(evt).balance; // revenue + deposit
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
        assertEq(platform.balance, FEE + leftovers, "Platform swept the leftovers");
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

    // GAS-INCLUSIVE PRICING

    /// @notice The buyer's gas comes out of the fee; the platform gets the
    /// rest; the escrow's share is unaffected.
    function test_buyGasSubsidy() public {
        helper_release(1);
        vm.txGasPrice(1 gwei);
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        evt.buy{value: PRICE}();

        uint256 spent = aliceBefore - alice.balance;
        assertLt(spent, PRICE, "Subsidy returned to the buyer");
        assertLt(platform.balance, FEE, "Platform bears the subsidy");
        assertEq(spent, PRICE - (FEE - platform.balance), "Split is exact");
    }

    /// @notice Refunds make the buyer whole including the claim's gas,
    /// funded by the organiser's deposit.
    function test_refundMakesBuyerWhole() public {
        vm.txGasPrice(1 gwei);
        helper_release(1);
        uint256 aliceStart = alice.balance;
        vm.prank(alice);
        uint256 ticketId = evt.buy{value: PRICE}();
        vm.prank(organiser);
        evt.closeEvent();

        vm.prank(alice);
        evt.claimRefund(ticketId);
        assertGe(alice.balance, aliceStart, "Buyer made whole incl. gas");
    }

    /// @notice Validators are reimbursed from the deposit for check-ins.
    function test_markUsedReimbursed() public {
        uint256 ticketId = helper_releaseAndBuy();
        vm.prank(organiser);
        evt.authorizeValidator(validator);
        vm.roll(ENTRY);

        vm.txGasPrice(1 gwei);
        vm.deal(validator, 1 ether);
        uint256 floatBefore = evt.gasFloat();
        vm.prank(validator);
        evt.markUsed(ticketId);
        assertGt(validator.balance, 1 ether, "Validator reimbursed");
        assertLt(evt.gasFloat(), floatBefore, "Reimbursement drawn from the float");
    }
}
