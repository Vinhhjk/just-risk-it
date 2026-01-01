import { useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useWallets } from '@privy-io/react-auth';
import { formatAddress } from '../../utils/formatAddress';

export function ConnectWalletButton() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [isPressed, setIsPressed] = useState(false);

  const handleClick = () => {
    if (!ready) return;

    if (authenticated && wallets.length > 0) {
      logout();
    } else {
      login();
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

  if (!ready) {
    return (
      <button
        className="px-8 py-4 font-black uppercase text-base md:text-lg tracking-wider disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        style={{
          backgroundColor: '#B8A7FF',
          color: '#000000',
          border: '3px solid #B8A7FF',
          borderRadius: '0px',
          boxShadow: '4px 4px 0px 0px #B8A7FF',
        }}
        disabled
      >
        Loading...
      </button>
    );
  }

  const isConnected = authenticated && wallets.length > 0;
  const walletAddress = wallets[0]?.address;

  return (
    <button
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      className="px-8 py-4 font-black uppercase text-base md:text-lg tracking-wider transition-all active:transition-none"
      style={{
        backgroundColor: '#B8A7FF',
        color: '#000000',
        border: '3px solid #B8A7FF',
        borderRadius: '0px',
        boxShadow: isPressed
          ? '2px 2px 0px 0px #B8A7FF'
          : '4px 4px 0px 0px #B8A7FF',
        transform: isPressed ? 'translate(2px, 2px)' : 'translate(0px, 0px)',
        cursor: 'pointer',
      }}
    >
      {isConnected && walletAddress
        ? formatAddress(walletAddress)
        : 'Connect Wallet'}
    </button>
  );
}

