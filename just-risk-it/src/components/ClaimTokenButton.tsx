import { useState } from 'react';
import { useWallets } from '@privy-io/react-auth';
import { usePrivy } from '@privy-io/react-auth';
import { writeContract, waitForTransactionReceipt } from 'viem/actions';
import { createWalletClient, createPublicClient, custom, http } from 'viem';
import { monadTestnet } from 'wagmi/chains';
import MockChogTokenABI from '../contracts/MockChogToken.json';

const MOCK_TOKEN_ADDRESS = import.meta.env.VITE_MOCK_TOKEN as `0x${string}`;

// Extract ABI from the JSON file
const abi = MockChogTokenABI.abi;

// Monad Testnet chain configuration
const MONAD_TESTNET_CHAIN = {
  id: 10143,
  name: 'Monad Testnet',
  network: 'monad-testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'MON',
    symbol: 'MON',
  },
  rpcUrls: {
    default: {
      http: ['https://testnet-rpc.monad.xyz'],
    },
    public: {
      http: ['https://testnet-rpc.monad.xyz'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Monad Explorer',
      url: 'https://testnet.monadexplorer.com',
    },
  },
  testnet: true,
};

export function ClaimTokenButton() {
  const { wallets } = useWallets();
  const { ready, authenticated } = usePrivy();
  const [isPressed, setIsPressed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  
  const isConnected = authenticated && wallets.length > 0;
  const wallet = wallets[0];

  const handleClaim = async () => {
    if (!isConnected || !MOCK_TOKEN_ADDRESS || !wallet || !ready) {
      return;
    }

    setIsLoading(true);
    setIsSuccess(false);

    try {
      // Get the wallet's provider
      const provider = await wallet.getEthereumProvider();
      
      // Create wallet client using Privy's provider
      const client = createWalletClient({
        account: wallet.address as `0x${string}`,
        chain: monadTestnet,
        transport: custom(provider),
      });

      // Check current chain and switch if needed
      try {
        const currentChainId = await provider.request({ method: 'eth_chainId' });
        const currentChainIdNumber = parseInt(currentChainId as string, 16);
        
        if (currentChainIdNumber !== MONAD_TESTNET_CHAIN.id) {
          // Try to switch to Monad Testnet
          try {
            await provider.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: `0x${MONAD_TESTNET_CHAIN.id.toString(16)}` }],
            });
          } catch (switchError: unknown) {
            // If the chain doesn't exist in the wallet, add it
            if (switchError && typeof switchError === 'object' && 'code' in switchError && switchError.code === 4902) {
              await provider.request({
                method: 'wallet_addEthereumChain',
                params: [
                  {
                    chainId: `0x${MONAD_TESTNET_CHAIN.id.toString(16)}`,
                    chainName: MONAD_TESTNET_CHAIN.name,
                    nativeCurrency: MONAD_TESTNET_CHAIN.nativeCurrency,
                    rpcUrls: MONAD_TESTNET_CHAIN.rpcUrls.default.http,
                    blockExplorerUrls: [MONAD_TESTNET_CHAIN.blockExplorers.default.url],
                  },
                ],
              });
            } else {
              throw switchError;
            }
          }
          
          // Wait a bit for the chain switch to complete
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (chainError) {
        console.error('Error switching chain:', chainError);
        setIsLoading(false);
        return;
      }

      // Write the contract
      const hash = await writeContract(client, {
        address: MOCK_TOKEN_ADDRESS,
        abi: abi,
        functionName: 'claim',
      });

      // Create public client to wait for transaction
      const publicClient = createPublicClient({
        chain: monadTestnet,
        transport: http(),
      });

      // Wait for transaction receipt
      await waitForTransactionReceipt(publicClient, {
        hash,
      });

      setIsSuccess(true);
      setIsLoading(false);
    } catch (err) {
      console.error('Error claiming tokens:', err);
      setIsLoading(false);
    }
  };

  const handleMouseDown = () => {
    setIsPressed(true);
  };

  const handleMouseUp = () => {
    setIsPressed(false);
  };

  const handleMouseLeave = () => {
    setIsPressed(false);
  };

  const isDisabled = !isConnected || isLoading || !MOCK_TOKEN_ADDRESS || !ready;

  return (
    <button
      onClick={handleClaim}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      disabled={isDisabled}
      className="px-6 py-3 font-black uppercase text-sm md:text-base tracking-wider transition-all active:transition-none disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        backgroundColor: '#B8A7FF',
        color: '#000000',
        border: '3px solid #B8A7FF',
        borderRadius: '0px',
        boxShadow: isPressed && !isDisabled
          ? '2px 2px 0px 0px #B8A7FF'
          : '4px 4px 0px 0px #B8A7FF',
        transform: isPressed && !isDisabled ? 'translate(2px, 2px)' : 'translate(0px, 0px)',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
      }}
    >
      {isLoading
        ? 'Claiming...'
        : isSuccess
        ? 'Claimed!'
        : 'Claim Test Token'}
    </button>
  );
}

