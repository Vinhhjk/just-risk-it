// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import { IEntropyConsumer } from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import { IEntropyV2 } from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title CrashGame
 * @notice Verifiably fair crash game using Pyth Entropy + commit-reveal
 * @dev Minimal storage design for scalability
 */
contract CrashGame is IEntropyConsumer {
    IEntropyV2 public immutable entropy;
    IERC20 public immutable token; // The game token (mCHOG)
    
    // House edge: 1.5% (0.015)
    // Applied to payouts: payout = betAmount * multiplier * (1 - 0.015)
    uint256 public constant HOUSE_EDGE_BPS = 150; // 1.5% in basis points (150/10000 = 0.015)
    uint256 public constant BPS_DENOMINATOR = 10000;
    
    // Max bet: 1000 tokens (assuming 18 decimals)
    uint256 public constant MAX_BET = 1000 * 1e18;
    
    // Max win per round per player: 70% of contract balance
    uint256 public constant MAX_WIN_PERCENTAGE_BPS = 7000; // 70% in basis points (7000/10000 = 0.70)
    
    // Minimal storage per round
    struct Round {
        bytes32 serverSeedHash; // Committed before randomness request
        bytes serverSeed;       // Revealed server seed (stored after reveal)
        uint64 sequenceNumber;   // Pyth Entropy sequence number
        uint256 entropyRandom;    // Settled entropy value (public)
        RoundStatus status;       // Replay protection
    }
    
    enum RoundStatus {
        Created,      // Round created, server seed hash committed
        RandomRequested, // Randomness requested, waiting for callback
        RandomReady,     // Randomness received via callback, game can start
        SeedRevealed  // Server seed revealed, fully verifiable
    }
    
    mapping(uint256 => Round) public rounds;
    uint256 public roundCounter;
    
    // Round ID per sequence number (to prevent rerolls)
    mapping(uint64 => uint256) public sequenceToRound;
    
    // Access control: only backend/operator can reveal seed and settle rounds
    address public operator;
    
    // Betting and payout system
    struct Bet {
        uint256 amount;
        uint256 cashOutMultiplier; // 0 if didn't cash out, in wei (1e18 = 1.00x)
        bool settled;
    }
    
    struct CashOut {
        address wallet;
        uint256 multiplier; // In wei (1e18 = 1.00x)
    }
    
    // User's bet for a specific round
    mapping(uint256 => mapping(address => Bet)) public bets;
    
    // User's claimable payouts (accumulated across rounds)
    mapping(address => uint256) public claimablePayouts;
    
    // Round settlement info
    mapping(uint256 => uint256) public roundFinalMultipliers; // roundId => finalMultiplier (in wei)
    mapping(uint256 => bool) public roundSettled; // roundId => settled
    
    // Events (cheap, scalable, indexed for queries)
    event RoundCreated(uint256 indexed roundId, bytes32 serverSeedHash);
    event RandomRequested(uint256 indexed roundId, uint64 sequenceNumber);
    event RandomReady(uint256 indexed roundId, uint256 entropyRandom);
    event ServerSeedRevealed(uint256 indexed roundId, bytes serverSeed);
    
    // Betting events
    event BetPlaced(uint256 indexed roundId, address indexed user, uint256 amount);
    event RoundSettled(uint256 indexed roundId, uint256 finalMultiplier);
    event PayoutClaimed(address indexed user, uint256 amount);
    
    modifier onlyOperator() {
        require(msg.sender == operator, "Not operator");
        _;
    }
    
    constructor(address _entropyAddress, address _operator, address _tokenAddress) {
        entropy = IEntropyV2(_entropyAddress);
        operator = _operator;
        token = IERC20(_tokenAddress);
        roundCounter = 1;
    }
    
    /**
     * @notice Create a new round with committed server seed hash
     * @param serverSeedHash keccak256(serverSeed) - must be committed before randomness request
     * @return roundId The ID of the newly created round
     */
    function createRound(bytes32 serverSeedHash) external returns (uint256) {
        uint256 roundId = roundCounter++;
        
        rounds[roundId] = Round({
            serverSeedHash: serverSeedHash,
            serverSeed: "",
            sequenceNumber: 0,
            entropyRandom: 0,
            status: RoundStatus.Created
        });
        
        emit RoundCreated(roundId, serverSeedHash);
        return roundId;
    }
    
    /**
     * @notice Request randomness from Pyth Entropy
     * @param roundId The round to request randomness for
     * @dev Pays the fee and requests randomness via requestV2
     */
    function requestRandomness(uint256 roundId) external payable {
        Round storage round = rounds[roundId];
        require(round.serverSeedHash != bytes32(0), "Round does not exist");
        require(round.status == RoundStatus.Created, "Invalid round status");
        require(round.sequenceNumber == 0, "Randomness already requested");
        
        // Get the fee for the request
        uint256 fee = entropy.getFeeV2();
        require(msg.value >= fee, "Insufficient fee");
        
        // Request the random number with the callback
        uint64 sequenceNumber = entropy.requestV2{ value: fee }();
        
        // Prevent rerolls - check BEFORE setting to avoid state corruption
        require(sequenceToRound[sequenceNumber] == 0, "Sequence number already used");
        
        // Only update state after successful Entropy call
        sequenceToRound[sequenceNumber] = roundId;
        round.sequenceNumber = sequenceNumber;
        round.status = RoundStatus.RandomRequested;
        
        emit RandomRequested(roundId, sequenceNumber);
        
        // Refund excess payment
        if (msg.value > fee) {
            (bool success, ) = payable(msg.sender).call{value: msg.value - fee}("");
            require(success, "Refund failed");
        }
    }
    
    /**
     * @notice Callback function called by Entropy when random number is ready
     * @param sequenceNumber The sequence number of the request
     * @param randomNumberBytes The generated random number (bytes32)
     * @dev This method is called by the entropy contract when a random number is generated.
     *      This method **must** be implemented on the same contract that requested the random number.
     *      This method should **never** return an error.
     */
    function entropyCallback(
        uint64 sequenceNumber,
        address /* provider */,
        bytes32 randomNumberBytes
    ) internal override {
        // Find the round for this sequence number
        uint256 roundId = sequenceToRound[sequenceNumber];
        require(roundId != 0, "Unknown sequence number");
        
        Round storage round = rounds[roundId];
        require(round.status == RoundStatus.RandomRequested, "Invalid round status");
        
        // Convert bytes32 to uint256 and store
        uint256 randomValue = uint256(randomNumberBytes);
        round.entropyRandom = randomValue;
        round.status = RoundStatus.RandomReady;
        
        emit RandomReady(roundId, randomValue);
    }
    
    /**
     * @notice Returns the address of the entropy contract
     * @dev Required by IEntropyConsumer interface
     */
    function getEntropy() internal view override returns (address) {
        return address(entropy);
    }
    
    /**
     * @notice Reveal server seed after game ends (verify + event only, no storage)
     * @param roundId The round to reveal seed for
     * @param serverSeed The server seed to reveal (as bytes)
     */
    function revealServerSeed(uint256 roundId, bytes calldata serverSeed) external {
        Round storage round = rounds[roundId];
        require(round.status == RoundStatus.RandomReady, "Randomness not ready");
        
        // Verify hash matches
        bytes32 computedHash = keccak256(serverSeed);
        require(computedHash == round.serverSeedHash, "Server seed hash mismatch");
        
        // Store server seed for easy retrieval
        round.serverSeed = serverSeed;
        
        // Update status for replay protection
        round.status = RoundStatus.SeedRevealed;
        
        // Emit event (cheap, indexed, queryable)
        emit ServerSeedRevealed(roundId, serverSeed);
    }
    
    /**
     * @notice Get round data
     * @param roundId The round ID
     * @return serverSeedHash The committed server seed hash
     * @return serverSeed The revealed server seed (empty if not revealed yet)
     * @return sequenceNumber The Pyth Entropy sequence number
     * @return entropyRandom The settled entropy value
     * @return status The current round status
     */
    function getRound(uint256 roundId) external view returns (
        bytes32 serverSeedHash,
        bytes memory serverSeed,
        uint64 sequenceNumber,
        uint256 entropyRandom,
        RoundStatus status
    ) {
        Round storage round = rounds[roundId];
        return (
            round.serverSeedHash,
            round.serverSeed,
            round.sequenceNumber,
            round.entropyRandom,
            round.status
        );
    }
    
    /**
     * @notice Check if randomness is ready for a round
     * @param roundId The round ID
     * @return true if randomness is ready
     */
    function isRandomReady(uint256 roundId) external view returns (bool) {
        Round storage round = rounds[roundId];
        return round.status == RoundStatus.RandomReady;
    }
    
    /**
     * @notice Update operator address (for access control)
     * @param newOperator The new operator address
     */
    function setOperator(address newOperator) external {
        require(msg.sender == operator, "Not operator");
        operator = newOperator;
    }
    
    /**
     * @notice Place a bet for a round (transfers tokens directly from wallet)
     * @param roundId The round ID to bet on
     * @param amount Amount of tokens to bet
     */
    function placeBet(uint256 roundId, uint256 amount) external {
        require(amount > 0, "Amount must be greater than 0");
        require(amount <= MAX_BET, "Bet amount exceeds maximum");
        require(!roundSettled[roundId], "Round already settled");
        require(rounds[roundId].serverSeedHash != bytes32(0), "Round does not exist");
        
        // Check if round is in betting phase (status is Created, RandomRequested, or RandomReady)
        // RandomReady means randomness is ready but game hasn't started yet - betting is still open
        Round storage round = rounds[roundId];
        require(
            round.status == RoundStatus.Created || 
            round.status == RoundStatus.RandomRequested || 
            round.status == RoundStatus.RandomReady,
            "Betting closed"
        );
        
        // Check if user already has a bet for this round
        require(bets[roundId][msg.sender].amount == 0, "Already placed bet");
        
        // Transfer tokens directly from user's wallet (must be approved first)
        require(token.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        
        bets[roundId][msg.sender] = Bet({
            amount: amount,
            cashOutMultiplier: 0,
            settled: false
        });
        
        emit BetPlaced(roundId, msg.sender, amount);
    }
    
    /**
     * @notice Settle a round with final multiplier (must be called first)
     * @param roundId The round ID to settle
     * @param finalMultiplier The final crash multiplier (in wei, 1e18 = 1.00x)
     * @param serverSeed The server seed to verify
     */
    function settleRound(
        uint256 roundId,
        uint256 finalMultiplier,
        bytes calldata serverSeed
    ) external onlyOperator {
        Round storage round = rounds[roundId];
        require(round.status == RoundStatus.SeedRevealed, "Server seed not revealed");
        require(!roundSettled[roundId], "Round already settled");
        require(finalMultiplier >= 1e18, "Invalid final multiplier"); // >= 1.00x
        
        // Verify server seed matches commitment
        bytes32 computedHash = keccak256(serverSeed);
        require(computedHash == round.serverSeedHash, "Server seed hash mismatch");
        
        // Mark round as settled
        roundSettled[roundId] = true;
        roundFinalMultipliers[roundId] = finalMultiplier;
        
        emit RoundSettled(roundId, finalMultiplier);
    }
    
    /**
     * @notice Process cash-outs in batches (can be called multiple times)
     * @param roundId The round ID
     * @param cashOuts Array of cash-outs to process (max ~50 per call to avoid gas limits)
     */
    function processCashOuts(
        uint256 roundId,
        CashOut[] calldata cashOuts
    ) external onlyOperator {
        require(roundSettled[roundId], "Round not settled");
        uint256 finalMultiplier = roundFinalMultipliers[roundId];
        require(finalMultiplier > 0, "Invalid round");
        
        // Process cash-outs in batch
        for (uint i = 0; i < cashOuts.length; i++) {
            address wallet = cashOuts[i].wallet;
            uint256 multiplier = cashOuts[i].multiplier;
            Bet storage bet = bets[roundId][wallet];
            
            // Verify bet exists and hasn't been settled
            require(bet.amount > 0, "No bet found");
            require(!bet.settled, "Already settled");
            
            // Verify multiplier is valid (1.00x to finalMultiplier)
            require(multiplier >= 1e18, "Multiplier too low"); // >= 1.00x
            require(multiplier <= finalMultiplier, "Multiplier too high");
            
            // Calculate payout with house edge: (amount * multiplier * (1 - houseEdge)) / 1e18
            // House edge is 1.5% (150 basis points), so we multiply by (10000 - 150) / 10000 = 9850 / 10000
            uint256 payoutBeforeFee = (bet.amount * multiplier) / 1e18;
            uint256 payout = (payoutBeforeFee * (BPS_DENOMINATOR - HOUSE_EDGE_BPS)) / BPS_DENOMINATOR;
            
            // Apply max win per round per player: 70% of contract balance
            uint256 contractBalance = token.balanceOf(address(this));
            uint256 maxWinPerPlayer = (contractBalance * MAX_WIN_PERCENTAGE_BPS) / BPS_DENOMINATOR;
            if (payout > maxWinPerPlayer) {
                payout = maxWinPerPlayer;
            }
            
            // Record cash-out
            bet.cashOutMultiplier = multiplier;
            bet.settled = true;
            
            // Add to claimable balance
            claimablePayouts[wallet] += payout;
        }
    }
    
    /**
     * @notice Claim all accumulated payouts
     */
    function claimAllPayouts() external {
        uint256 total = claimablePayouts[msg.sender];
        require(total > 0, "No payouts to claim");
        
        claimablePayouts[msg.sender] = 0;
        require(token.transfer(msg.sender, total), "Transfer failed");
        
        emit PayoutClaimed(msg.sender, total);
    }
    
    /**
     * @notice Withdraw all token balance from contract (operator only)
     * @dev This withdraws the house edge fees collected from payouts
     */
    function withdrawHouseEdge() external onlyOperator {
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "No balance to withdraw");
        require(token.transfer(operator, balance), "Transfer failed");
    }
    
    /**
     * @notice Get user's bet for a round
     * @param roundId The round ID
     * @param user The user address
     * @return amount The bet amount
     * @return cashOutMultiplier The cash-out multiplier (0 if didn't cash out)
     * @return settled Whether the bet has been settled
     */
    function getBet(uint256 roundId, address user) external view returns (
        uint256 amount,
        uint256 cashOutMultiplier,
        bool settled
    ) {
        Bet storage bet = bets[roundId][user];
        return (bet.amount, bet.cashOutMultiplier, bet.settled);
    }
}
