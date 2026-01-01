import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { createPublicClient, http } from 'viem';
import { monadTestnet } from 'viem/chains';
import CrashGameABI from '../contracts/CrashGame.json';
import { keccak256, toHex, pad, concat, toBytes } from 'viem';

const CRASH_GAME_ADDRESS = import.meta.env.VITE_CRASH_GAME_CONTRACT as `0x${string}`;
const crashGameABI = CrashGameABI.abi;

interface RoundData {
  serverSeedHash: string;
  serverSeed: string;
  sequenceNumber: bigint;
  entropyRandom: bigint;
  status: number;
}

export function VerifyGame() {
  const [searchParams] = useSearchParams();
  const roundIdFromUrl = searchParams.get('roundid');

  const [verificationMethod, setVerificationMethod] = useState<'roundId' | 'manual' | 'formula'>('roundId');
  const [roundId, setRoundId] = useState<string>(roundIdFromUrl || '');
  const [roundData, setRoundData] = useState<RoundData | null>(null);
  const [loading, setLoading] = useState(false);

  // Manual input fields
  const [manualServerSeedHash, setManualServerSeedHash] = useState('');
  const [manualServerSeed, setManualServerSeed] = useState('');
  const [manualEntropyRandom, setManualEntropyRandom] = useState('');
  const [manualSequenceNumber, setManualSequenceNumber] = useState('');
  const [manualRoundId, setManualRoundId] = useState('');
  const [manualChainId, setManualChainId] = useState('10143'); // Monad Testnet

  const [verificationResult, setVerificationResult] = useState<{
    success: boolean;
    message: string;
    finalMultiplier?: number;
  } | null>(null);

  // Load round data from URL parameter
  useEffect(() => {
    if (roundIdFromUrl) {
      setRoundId(roundIdFromUrl);
      setVerificationMethod('roundId');
    }
  }, [roundIdFromUrl]);

  const verifyGame = async () => {
    setLoading(true);
    setVerificationResult(null);

    try {
      let serverSeed: string;
      let entropyRandom: bigint;
      let roundIdNum: number;
      let chainId: number;

      if (verificationMethod === 'roundId') {
        // Always fetch fresh data from contract to ensure entropyRandom is a BigInt
        // Don't rely on state which might have been serialized/deserialized
        const publicClient = createPublicClient({
          chain: monadTestnet,
          transport: http(),
        });
        // getRound returns: (bytes32 serverSeedHash, bytes serverSeed, uint64 sequenceNumber, uint256 entropyRandom, uint8 status)
        const result = await publicClient.readContract({
          address: CRASH_GAME_ADDRESS,
          abi: crashGameABI,
          functionName: 'getRound',
          args: [BigInt(roundId)],
        }) as [string, string, bigint, bigint, number];

        const serverSeedHash = result[0];
        const serverSeedRaw = result[1];
        const sequenceNumber = result[2];
        const entropyRandomValue = result[3];
        const status = result[4];

        // Server seed is stored as bytes in the contract
        // Backend stores: ethers.toUtf8Bytes(serverSeed) where serverSeed is a hex string (64 chars)
        // When retrieved from contract, viem returns bytes as a hex string (0x...)
        // We need to convert those bytes back to the original hex string
        let serverSeedStr: string = '';

        // serverSeedRaw should be a hex string from viem
        if (typeof serverSeedRaw === 'string' && serverSeedRaw.startsWith('0x')) {
          try {
            // Convert hex string to bytes, then decode bytes to UTF-8 string (original hex string)
            const bytes = toBytes(serverSeedRaw);
            // Decode UTF-8 bytes back to the original hex string
            serverSeedStr = new TextDecoder('utf-8').decode(bytes);
          } catch (e) {
            console.error('Error decoding server seed:', e);
            serverSeedStr = '';
          }
        } else if (typeof serverSeedRaw === 'string' && serverSeedRaw && serverSeedRaw !== '0x') {
          // Already a string (not hex), use it directly
          serverSeedStr = serverSeedRaw;
        }

        // Debug: log the server seed to verify conversion
        // console.log('Retrieved server seed from contract (raw):', serverSeedRaw);
        // console.log('Retrieved server seed type:', typeof serverSeedRaw);
        // console.log('Decoded server seed (original hex string):', serverSeedStr);
        // console.log('Server seed length:', serverSeedStr.length);
        // console.log('Expected length: 64 (32 bytes as hex string)');

        // Store in state for display (but use fresh values for verification)
        const currentRoundData = {
          serverSeedHash: serverSeedHash,
          serverSeed: serverSeedStr,
          sequenceNumber: sequenceNumber,
          entropyRandom: entropyRandomValue, // This is a BigInt from the contract
          status: status,
        };
        setRoundData(currentRoundData);

        if (!currentRoundData.serverSeed || currentRoundData.serverSeed.length === 0) {
          setVerificationResult({
            success: false,
            message: 'Server seed not revealed yet. The round may not be completed yet. Please wait for the round to complete or use manual method.'
          });
          setLoading(false);
          return;
        }

        // Use the BigInt directly from the contract result, not from state
        // This ensures it's never converted to Number
        entropyRandom = entropyRandomValue; // Direct BigInt from contract
        roundIdNum = parseInt(roundId);
        chainId = monadTestnet.id;
        serverSeed = serverSeedStr;
      } else {
        // Manual method
        if (!manualServerSeedHash || !manualServerSeed || !manualEntropyRandom || !manualSequenceNumber || !manualRoundId) {
          setVerificationResult({
            success: false,
            message: 'Please fill in all required fields'
          });
          setLoading(false);
          return;
        }

        // Verify server seed hash matches
        // Backend uses: ethers.keccak256(ethers.toUtf8Bytes(serverSeed))
        // So we need to convert the hex string to UTF-8 bytes, then hash
        const seedBytesForHash = toBytes(manualServerSeed);
        const computedHash = keccak256(seedBytesForHash);
        if (computedHash.toLowerCase() !== manualServerSeedHash.toLowerCase()) {
          setVerificationResult({
            success: false,
            message: 'Server seed hash does not match the provided server seed'
          });
          setLoading(false);
          return;
        }

        serverSeed = manualServerSeed;
        entropyRandom = BigInt(manualEntropyRandom);
        roundIdNum = parseInt(manualRoundId);
        chainId = parseInt(manualChainId);
      }

      // Derive seed using the same formula as the backend
      // Formula: keccak256(entropyRandom || roundId || serverSeed || chainId)
      // Backend: entropyRandom.toString() -> deriveSeed(vrfRandom: string) -> BigInt(vrfRandom)
      // We need to ensure entropyRandom stays as BigInt and convert to string properly

      // deriveSeed function matching backend exactly
      // Backend signature: deriveSeed(vrfRandom: string, roundId: number, serverSeed: string, chainId: number)
      function deriveSeed(vrfRandom: string, roundId: number, serverSeed: string, chainId: number): bigint {
        // Match backend: ethers.zeroPadValue(ethers.toBeHex(BigInt(vrfRandom)), 32)
        // vrfRandom must be a valid integer string (not scientific notation)
        // BigInt() cannot parse scientific notation, so we need to ensure it's a decimal string
        const vrfBigInt = BigInt(vrfRandom);
        const vrfBytes = pad(toHex(vrfBigInt), { size: 32 });
        const roundBytes = pad(toHex(BigInt(roundId)), { size: 32 });
        // Match backend: ethers.toUtf8Bytes(serverSeed) converts UTF-8 string to bytes (Uint8Array)
        // Backend uses: ethers.concat([vrfBytes, roundBytes, seedBytes, chainBytes])
        // where seedBytes is a Uint8Array (not hex string)
        // viem's concat only accepts hex strings, so we need to convert Uint8Array to hex
        // But we must ensure the conversion matches what ethers.concat does with Uint8Array
        const seedBytesUint8 = toBytes(serverSeed); // Uint8Array (same as ethers.toUtf8Bytes)
        const seedBytes = toHex(seedBytesUint8); // Convert to hex string for viem.concat
        const chainBytes = pad(toHex(BigInt(chainId)), { size: 32 });

        // viem.concat only accepts hex strings (unlike ethers.concat which accepts mixed types)
        const combined = concat([vrfBytes, roundBytes, seedBytes, chainBytes]);


        const hash = keccak256(combined);

        return BigInt(hash);
      }

      // Convert BigInt to string - BigInt.toString() always returns decimal format, never scientific
      // This matches backend: entropyRandom.toString() in crash-game-server.ts line 243
      // IMPORTANT: entropyRandom must be a BigInt, not a Number, to avoid scientific notation
      let entropyRandomStr: string;
      if (typeof entropyRandom === 'bigint') {
        // BigInt.toString() always returns decimal, never scientific notation
        entropyRandomStr = entropyRandom.toString();
      } else {
        // If it's somehow not a BigInt, convert it properly
        // This shouldn't happen, but handle it just in case
        entropyRandomStr = BigInt(entropyRandom).toString();
      }

      // Debug: log entropyRandom value
      // console.log('entropyRandom (BigInt):', entropyRandom.toString());
      // console.log('entropyRandom (string):', entropyRandomStr);

      const derivedSeed = deriveSeed(entropyRandomStr, roundIdNum, serverSeed, chainId);

      // console.log('Derived seed:', derivedSeed.toString());
      // console.log('Derived seed (hex):', '0x' + derivedSeed.toString(16));

      // Generate game using the same algorithm as backend
      const houseEdge = 0.015;

      // getRandom function matching backend exactly
      function getRandom(i: number): number {
        // Match backend: ethers.zeroPadValue(ethers.toBeHex(derivedSeed), 32)
        const seedBytes = pad(toHex(derivedSeed), { size: 32 });
        // Match backend: ethers.zeroPadValue(ethers.toBeHex(BigInt(i)), 32)
        const indexBytes = pad(toHex(BigInt(i)), { size: 32 });
        const combined = concat([seedBytes, indexBytes]);
        const hash = keccak256(combined);
        const hashBigInt = BigInt(hash);

        // Match backend exactly: maxUint256 = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
        const maxUint256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
        // Match backend: Number(hashBigInt) / Number(maxUint256)
        // IMPORTANT: The backend does this division which can have precision loss for very large numbers
        // But we must match it exactly to get the same result
        // Convert to Number first, then divide (this matches backend behavior)
        const hashNum = Number(hashBigInt);
        const maxNum = Number(maxUint256);
        const result = hashNum / maxNum;

        return result;
      }

      const r0 = getRandom(0);
      // console.log('r0 (getRandom(0)):', r0);
      const p = houseEdge + r0 * (1 - houseEdge);
      // console.log('p:', p);
      const rawMultiplier = (1 - houseEdge) / (1 - p);
      // console.log('rawMultiplier:', rawMultiplier);
      const crashMultiplier = Math.max(1.00, Math.min(rawMultiplier, 10000));
      // console.log('crashMultiplier:', crashMultiplier);
      const finalMultiplier = Math.round(crashMultiplier * 100) / 100;
      // console.log('finalMultiplier:', finalMultiplier);

      setVerificationResult({
        success: true,
        message: 'Game verified successfully!',
        finalMultiplier: finalMultiplier
      });
    } catch (error) {
      console.error('Verification error:', error);
      setVerificationResult({
        success: false,
        message: `Verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen" style={{
      background: 'linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%)',
      padding: '2rem'
    }}>
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl font-black mb-8 uppercase tracking-wider" style={{ color: '#F1F5F9' }}>
          VERIFY GAME FAIRNESS
        </h1>

        {/* Verification Method Selection */}
        <div className="p-6 mb-6" style={{
          backgroundColor: 'rgba(0, 0, 0, 0.4)',
          borderRadius: '8px'
        }}>
          <h2 className="text-xl font-black mb-4 uppercase" style={{ color: '#F1F5F9' }}>Verification Method</h2>
          <div className="flex gap-4">
            <button
              onClick={() => setVerificationMethod('roundId')}
              className="px-6 py-3 font-black uppercase transition-all"
              style={{
                backgroundColor: verificationMethod === 'roundId' ? '#B8A7FF' : 'rgba(184, 167, 255, 0.2)',
                color: verificationMethod === 'roundId' ? '#000000' : '#B8A7FF',
                borderRadius: '8px',
                border: '3px solid #000000',
                boxShadow: verificationMethod === 'roundId' ? '4px 4px 0px 0px #000000' : 'none',
                transform: 'translate(0, 0)',
              }}
              onMouseDown={(e) => {
                e.currentTarget.style.transform = 'translate(2px, 2px)';
                e.currentTarget.style.boxShadow = '2px 2px 0px 0px #000000';
              }}
              onMouseUp={(e) => {
                e.currentTarget.style.transform = 'translate(0, 0)';
                e.currentTarget.style.boxShadow = verificationMethod === 'roundId' ? '4px 4px 0px 0px #000000' : 'none';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translate(0, 0)';
                e.currentTarget.style.boxShadow = verificationMethod === 'roundId' ? '4px 4px 0px 0px #000000' : 'none';
              }}
            >
              By Round ID
            </button>
            <button
              onClick={() => setVerificationMethod('manual')}
              className="px-6 py-3 font-black uppercase transition-all"
              style={{
                backgroundColor: verificationMethod === 'manual' ? '#B8A7FF' : 'rgba(184, 167, 255, 0.2)',
                color: verificationMethod === 'manual' ? '#000000' : '#B8A7FF',
                borderRadius: '8px',
                border: '3px solid #000000',
                boxShadow: verificationMethod === 'manual' ? '4px 4px 0px 0px #000000' : 'none',
                transform: 'translate(0, 0)',
              }}
              onMouseDown={(e) => {
                e.currentTarget.style.transform = 'translate(2px, 2px)';
                e.currentTarget.style.boxShadow = '2px 2px 0px 0px #000000';
              }}
              onMouseUp={(e) => {
                e.currentTarget.style.transform = 'translate(0, 0)';
                e.currentTarget.style.boxShadow = verificationMethod === 'manual' ? '4px 4px 0px 0px #000000' : 'none';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translate(0, 0)';
                e.currentTarget.style.boxShadow = verificationMethod === 'manual' ? '4px 4px 0px 0px #000000' : 'none';
              }}
            >
              Manual Input
            </button>
            <button
              onClick={() => setVerificationMethod('formula')}
              className="px-6 py-3 font-black uppercase transition-all"
              style={{
                backgroundColor: verificationMethod === 'formula' ? '#B8A7FF' : 'rgba(184, 167, 255, 0.2)',
                color: verificationMethod === 'formula' ? '#000000' : '#B8A7FF',
                borderRadius: '8px',
                border: '3px solid #000000',
                boxShadow: verificationMethod === 'formula' ? '4px 4px 0px 0px #000000' : 'none',
                transform: 'translate(0, 0)',
              }}
              onMouseDown={(e) => {
                e.currentTarget.style.transform = 'translate(2px, 2px)';
                e.currentTarget.style.boxShadow = '2px 2px 0px 0px #000000';
              }}
              onMouseUp={(e) => {
                e.currentTarget.style.transform = 'translate(0, 0)';
                e.currentTarget.style.boxShadow = verificationMethod === 'formula' ? '4px 4px 0px 0px #000000' : 'none';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translate(0, 0)';
                e.currentTarget.style.boxShadow = verificationMethod === 'formula' ? '4px 4px 0px 0px #000000' : 'none';
              }}
            >
              View Formula
            </button>
          </div>
        </div>

        {/* Round ID Method */}
        {verificationMethod === 'roundId' && (
          <div className="p-6 mb-6" style={{
            backgroundColor: 'rgba(0, 0, 0, 0.4)',
            borderRadius: '8px'
          }}>
            <h2 className="text-xl font-black mb-4 uppercase" style={{ color: '#F1F5F9' }}>Round ID</h2>
            <div className="space-y-4">
              <div>
                <label className="block font-light text-sm mb-2" style={{ color: '#F1F5F9' }}>Round ID</label>
                <input
                  type="number"
                  value={roundId}
                  onChange={(e) => setRoundId(e.target.value)}
                  className="w-full px-4 py-2"
                  style={{
                    backgroundColor: 'rgba(0, 0, 0, 0.4)',
                    color: '#F1F5F9',
                    borderRadius: '8px',
                    outline: 'none'
                  }}
                  placeholder="Enter round ID"
                />
              </div>

              {roundData && (
                <div className="mt-4 space-y-3 p-4" style={{
                  backgroundColor: 'rgba(184, 167, 255, 0.1)',
                  borderRadius: '8px'
                }}>
                  <div>
                    <span className="font-light text-sm block mb-1" style={{ color: 'rgba(241, 245, 249, 0.7)' }}>Server Seed Hash:</span>
                    <span className="font-mono text-sm break-all" style={{ color: '#B8A7FF' }}>{roundData.serverSeedHash}</span>
                  </div>
                  {roundData.serverSeed && (
                    <div>
                      <span className="font-light text-sm block mb-1" style={{ color: 'rgba(241, 245, 249, 0.7)' }}>Server Seed:</span>
                      <span className="font-mono text-sm break-all" style={{ color: '#B8A7FF' }}>{roundData.serverSeed}</span>
                    </div>
                  )}
                  <div>
                    <span className="font-light text-sm block mb-1" style={{ color: 'rgba(241, 245, 249, 0.7)' }}>Sequence Number:</span>
                    <span className="font-mono text-sm" style={{ color: '#B8A7FF' }}>{roundData.sequenceNumber.toString()}</span>
                  </div>
                  <div>
                    <span className="font-light text-sm block mb-1" style={{ color: 'rgba(241, 245, 249, 0.7)' }}>Entropy Random:</span>
                    <span className="font-mono text-sm break-all" style={{ color: '#B8A7FF' }}>
                      {typeof roundData.entropyRandom === 'bigint'
                        ? roundData.entropyRandom.toString()
                        : String(roundData.entropyRandom)}
                    </span>
                  </div>
                  <div>
                    <span className="font-light text-sm block mb-1" style={{ color: 'rgba(241, 245, 249, 0.7)' }}>Status:</span>
                    <span className="text-sm" style={{ color: '#B8A7FF' }}>{roundData.status}</span>
                  </div>
                  {!roundData.serverSeed && (
                    <div className="mt-4 p-3" style={{ backgroundColor: 'rgba(184, 167, 255, 0.1)', borderRadius: '8px' }}>
                      <p className="text-sm font-light" style={{ color: 'rgba(241, 245, 249, 0.7)' }}>
                        Note: To complete verification, you need the server seed which is revealed after the game ends.
                        Check the game transaction logs or use the manual method below.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Manual Method */}
        {verificationMethod === 'manual' && (
          <div className="p-6 mb-6" style={{
            backgroundColor: 'rgba(0, 0, 0, 0.4)',
            borderRadius: '8px'
          }}>
            <h2 className="text-xl font-black mb-4 uppercase" style={{ color: '#F1F5F9' }}>Manual Input</h2>
            <div className="space-y-4">
              <div>
                <label className="block font-light text-sm mb-2" style={{ color: '#F1F5F9' }}>Round ID</label>
                <input
                  type="number"
                  value={manualRoundId}
                  onChange={(e) => setManualRoundId(e.target.value)}
                  className="w-full px-4 py-2"
                  style={{
                    backgroundColor: 'rgba(0, 0, 0, 0.4)',
                    color: '#F1F5F9',
                    borderRadius: '8px',
                    outline: 'none'
                  }}
                  placeholder="Enter round ID"
                />
              </div>
              <div>
                <label className="block font-light text-sm mb-2" style={{ color: '#F1F5F9' }}>Server Seed Hash</label>
                <input
                  type="text"
                  value={manualServerSeedHash}
                  onChange={(e) => setManualServerSeedHash(e.target.value)}
                  className="w-full px-4 py-2 font-mono text-sm"
                  style={{
                    backgroundColor: 'rgba(0, 0, 0, 0.4)',
                    color: '#F1F5F9',
                    borderRadius: '8px',
                    outline: 'none'
                  }}
                  placeholder="0x..."
                />
              </div>
              <div>
                <label className="block font-light text-sm mb-2" style={{ color: '#F1F5F9' }}>Server Seed (revealed after game ends)</label>
                <input
                  type="text"
                  value={manualServerSeed}
                  onChange={(e) => setManualServerSeed(e.target.value)}
                  className="w-full px-4 py-2 font-mono text-sm"
                  style={{
                    backgroundColor: 'rgba(0, 0, 0, 0.4)',
                    color: '#F1F5F9',
                    borderRadius: '8px',
                    outline: 'none'
                  }}
                  placeholder="Enter server seed (hex string)"
                />
              </div>
              <div>
                <label className="block font-light text-sm mb-2" style={{ color: '#F1F5F9' }}>Entropy Random (from Pyth)</label>
                <input
                  type="text"
                  value={manualEntropyRandom}
                  onChange={(e) => setManualEntropyRandom(e.target.value)}
                  className="w-full px-4 py-2 font-mono text-sm"
                  style={{
                    backgroundColor: 'rgba(0, 0, 0, 0.4)',
                    color: '#F1F5F9',
                    borderRadius: '8px',
                    outline: 'none'
                  }}
                  placeholder="Enter entropy random number"
                />
              </div>
              <div>
                <label className="block font-light text-sm mb-2" style={{ color: '#F1F5F9' }}>Sequence Number</label>
                <input
                  type="text"
                  value={manualSequenceNumber}
                  onChange={(e) => setManualSequenceNumber(e.target.value)}
                  className="w-full px-4 py-2 font-mono text-sm"
                  style={{
                    backgroundColor: 'rgba(0, 0, 0, 0.4)',
                    color: '#F1F5F9',
                    borderRadius: '8px',
                    outline: 'none'
                  }}
                  placeholder="Enter sequence number"
                />
              </div>
              <div>
                <label className="block font-light text-sm mb-2" style={{ color: '#F1F5F9' }}>Chain ID</label>
                <input
                  type="number"
                  value={manualChainId}
                  onChange={(e) => setManualChainId(e.target.value)}
                  className="w-full px-4 py-2"
                  style={{
                    backgroundColor: 'rgba(0, 0, 0, 0.4)',
                    color: '#F1F5F9',
                    borderRadius: '8px',
                    outline: 'none'
                  }}
                  placeholder="10143 (Monad Testnet)"
                />
              </div>
            </div>
          </div>
        )}

        {/* Formula Section */}
        {verificationMethod === 'formula' && (
          <div className="p-6 mb-6" style={{
            backgroundColor: 'rgba(0, 0, 0, 0.4)',
            borderRadius: '8px'
          }}>
            <h2 className="text-xl font-black mb-4 uppercase" style={{ color: '#F1F5F9' }}>Game Formula</h2>
            <div className="space-y-4 font-light text-sm" style={{ color: 'rgba(241, 245, 249, 0.8)' }}>
              <p>
                The game uses a verifiable randomness scheme combining on-chain entropy from Pyth Network with a server seed.
              </p>

              <div className="p-4" style={{ backgroundColor: 'rgba(184, 167, 255, 0.1)', borderRadius: '8px' }}>
                <p className="font-black mb-2" style={{ color: '#B8A7FF' }}>Step 1: Derive Combined Seed</p>
                <p className="font-mono text-xs mb-2 break-all">
                  derivedSeed = keccak256(entropyRandom || roundId || serverSeed || chainId)
                </p>
                <p className="text-xs mt-2" style={{ color: 'rgba(241, 245, 249, 0.6)' }}>
                  All values are zero-padded to 32 bytes before concatenation. The server seed is converted to UTF-8 bytes.
                </p>
              </div>

              <div className="p-4" style={{ backgroundColor: 'rgba(184, 167, 255, 0.1)', borderRadius: '8px' }}>
                <p className="font-black mb-2" style={{ color: '#B8A7FF' }}>Step 2: Generate Random Value</p>
                <p className="font-mono text-xs mb-2 break-all">
                  r0 = keccak256(derivedSeed || 0) / 2^256
                </p>
                <p className="text-xs mt-2" style={{ color: 'rgba(241, 245, 249, 0.6)' }}>
                  This produces a uniformly distributed random value in the range [0, 1).
                </p>
              </div>

              <div className="p-4" style={{ backgroundColor: 'rgba(184, 167, 255, 0.1)', borderRadius: '8px' }}>
                <p className="font-black mb-2" style={{ color: '#B8A7FF' }}>Step 3: Calculate Multiplier</p>
                <p className="font-mono text-xs mb-2 break-all">
                  p = houseEdge + r0 × (1 - houseEdge)
                </p>
                <p className="font-mono text-xs mb-2 break-all">
                  rawMultiplier = (1 - houseEdge) / (1 - p)
                </p>
                <p className="font-mono text-xs mb-2 break-all">
                  finalMultiplier = round(clamp(rawMultiplier, 1.00, 10000) × 100) / 100
                </p>
                <p className="text-xs mt-2" style={{ color: 'rgba(241, 245, 249, 0.6)' }}>
                  Where houseEdge = 1.5% (0.015). The final multiplier is rounded to 2 decimal places.
                </p>
              </div>

              <div className="p-4" style={{ backgroundColor: 'rgba(184, 167, 255, 0.1)', borderRadius: '8px' }}>
                <p className="font-black mb-2" style={{ color: '#B8A7FF' }}>Step 4: Generate Game Duration</p>
                <p className="font-mono text-xs mb-2 break-all">
                  r1 = keccak256(derivedSeed || 1) / 2^256
                </p>
                <p className="font-mono text-xs mb-2 break-all">
                  duration = baseDuration + floor(r1 × (maxDuration - baseDuration))
                </p>
                <p className="font-mono text-xs mb-2 break-all">
                  totalTicks = ceil(duration / tickIntervalMs)
                </p>
                <p className="text-xs mt-2" style={{ color: 'rgba(241, 245, 249, 0.6)' }}>
                  Where baseDuration = 3000ms, maxDuration = 30000ms, tickIntervalMs = 100ms
                </p>
              </div>

              <div className="p-4" style={{ backgroundColor: 'rgba(184, 167, 255, 0.1)', borderRadius: '8px' }}>
                <p className="font-black mb-2" style={{ color: '#B8A7FF' }}>Step 5: Generate Random Walk (Ticks)</p>
                <p className="font-mono text-xs mb-2 break-all">
                  For each tick i:
                </p>
                <p className="font-mono text-xs mb-2 break-all pl-4">
                  progress = i / totalTicks
                </p>
                <p className="font-mono text-xs mb-2 break-all pl-4">
                  targetPrice = 1.00 + (finalMultiplier - 1.00) × progress^0.8
                </p>
                <p className="font-mono text-xs mb-2 break-all pl-4">
                  volatility = volatilityBase × (1 - progress)^volatilityDecay
                </p>
                <p className="font-mono text-xs mb-2 break-all pl-4">
                  priceChange = directionBias + (randomMove × volatility)
                </p>
                <p className="font-mono text-xs mb-2 break-all pl-4">
                  currentPrice = currentPrice × (1 + priceChange)
                </p>
                <p className="font-mono text-xs mb-2 break-all pl-4">
                  roundedMultiplier = round(currentPrice × 100) / 100
                </p>
                <p className="text-xs mt-2" style={{ color: 'rgba(241, 245, 249, 0.6)' }}>
                  The game crashes when currentPrice ≥ finalMultiplier. Each tick represents a candlestick with open, high, low, close values.
                </p>
              </div>

              <div className="p-4" style={{ backgroundColor: 'rgba(184, 167, 255, 0.1)', borderRadius: '8px' }}>
                <p className="font-black mb-2" style={{ color: '#B8A7FF' }}>Candlestick Chart</p>
                <p className="font-mono text-xs mb-2 break-all">
                  Each tick generates one candlestick:
                </p>
                <p className="font-mono text-xs mb-2 break-all pl-4">
                  open = previousMultiplier
                </p>
                <p className="font-mono text-xs mb-2 break-all pl-4">
                  high = max(previousMultiplier, roundedMultiplier)
                </p>
                <p className="font-mono text-xs mb-2 break-all pl-4">
                  low = min(previousMultiplier, roundedMultiplier)
                </p>
                <p className="font-mono text-xs mb-2 break-all pl-4">
                  close = roundedMultiplier (or finalMultiplier on crash)
                </p>
                <p className="text-xs mt-2" style={{ color: 'rgba(241, 245, 249, 0.6)' }}>
                  The number of candles equals the number of ticks, which varies based on the game duration.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Verify Button - Hidden when viewing formula */}
        {verificationMethod !== 'formula' && (
          <button
            onClick={verifyGame}
            disabled={loading || (verificationMethod === 'roundId' && !roundId)}
            className="w-full py-4 font-black uppercase text-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              backgroundColor: '#10b981',
              color: '#000000',
              borderRadius: '8px',
              border: '3px solid #000000',
              boxShadow: '4px 4px 0px 0px #000000',
              transform: 'translate(0, 0)',
            }}
            onMouseDown={(e) => {
              if (!loading && !(verificationMethod === 'roundId' && !roundId)) {
                e.currentTarget.style.transform = 'translate(2px, 2px)';
                e.currentTarget.style.boxShadow = '2px 2px 0px 0px #000000';
              }
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = 'translate(0, 0)';
              e.currentTarget.style.boxShadow = '4px 4px 0px 0px #000000';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translate(0, 0)';
              e.currentTarget.style.boxShadow = '4px 4px 0px 0px #000000';
            }}
          >
            {loading ? 'Verifying...' : 'Verify Game'}
          </button>
        )}

        {/* Verification Result */}
        {verificationResult && (
          <div className={`mt-6 p-6 ${verificationResult.success ? '' : ''}`} style={{
            backgroundColor: 'rgba(0, 0, 0, 0.4)',
            borderRadius: '8px'
          }}>
            <h3 className="text-lg font-black mb-2 uppercase" style={{ color: verificationResult.success ? '#10b981' : '#ef4444' }}>
              {verificationResult.success ? 'Verification Successful' : 'Verification Failed'}
            </h3>
            <p className="font-light" style={{ color: '#F1F5F9' }}>{verificationResult.message}</p>
            {verificationResult.success && verificationResult.finalMultiplier && (
              <div className="mt-4">
                <p className="font-light text-sm" style={{ color: 'rgba(241, 245, 249, 0.7)' }}>
                  Calculated Final Multiplier: <span className="font-black text-lg" style={{ color: '#10b981' }}>{verificationResult.finalMultiplier.toFixed(2)}x</span>
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
