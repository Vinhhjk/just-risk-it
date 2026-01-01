// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.28;

import { IEntropyConsumer } from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import { IEntropyV2 } from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";

/**
 * @title PythEntropyTest
 * @notice Test contract for Pyth Entropy following the official docs
 * @dev Based on: https://docs.pyth.network/entropy/generate-random-numbers-evm
 */
contract PythEntropyTest is IEntropyConsumer {
    // Reference to the Entropy contract
    IEntropyV2 public entropy;

    // Random Number to receive from Entropy
    uint256 public randomNumber;

    // Track sequence numbers to requests
    mapping(uint64 => bool) public requests;

    // Events
    event RandomNumberRequested(uint64 indexed sequenceNumber);
    event RandomNumberReceived(uint64 indexed sequenceNumber, address provider, bytes32 randomNumber);

    /**
     * @param entropyAddress The address of the entropy contract
     */
    constructor(address entropyAddress) {
        entropy = IEntropyV2(entropyAddress);
    }

    /**
     * @notice Request a random number from Entropy
     * @dev Pays the fee and requests randomness via requestV2
     */
    function requestRandomNumber() external payable {
        // Get the fee for the request
        uint256 fee = entropy.getFeeV2();

        // Request the random number with the callback
        uint64 sequenceNumber = entropy.requestV2{ value: fee }();

        // Store the sequence number to identify the callback request
        requests[sequenceNumber] = true;

        emit RandomNumberRequested(sequenceNumber);
    }

    /**
     * @notice Callback function called by Entropy when random number is ready
     * @param sequenceNumber The sequence number of the request
     * @param provider The address of the provider that generated the random number
     * @param randomNumberBytes The generated random number (bytes32)
     * @dev This method is called by the entropy contract when a random number is generated.
     *      This method **must** be implemented on the same contract that requested the random number.
     *      This method should **never** return an error.
     */
    function entropyCallback(
        uint64 sequenceNumber,
        address provider,
        bytes32 randomNumberBytes
    ) internal override {
        // Convert bytes32 to uint256 for easier use
        uint256 randomValue = uint256(randomNumberBytes);
        
        // Store the random number
        randomNumber = randomValue;

        emit RandomNumberReceived(sequenceNumber, provider, randomNumberBytes);
    }

    /**
     * @notice Returns the address of the entropy contract
     * @dev Required by IEntropyConsumer interface
     */
    function getEntropy() internal view override returns (address) {
        return address(entropy);
    }

    /**
     * @notice Helper function to get a random number in a range (0 to range-1)
     * @param range The upper bound (exclusive)
     * @return A random number between 0 and range-1
     */
    function getRandomInRange(uint256 range) external view returns (uint256) {
        require(randomNumber != 0, "Randomness not yet received");
        require(range > 0, "Range must be greater than 0");
        return randomNumber % range;
    }
}

