interface Player {
  id: string;
  name: string;
  bet: number;
  cashOut?: number;
  payout?: number;
  status: 'pending' | 'cashed_out' | 'crashed';
}

interface PlayerListProps {
  players: Player[];
  totalBetting: number;
  playerCount: number;
  roundId: number | null;
}

export function PlayerList({ players, totalBetting, playerCount, roundId }: PlayerListProps) {
  return (
    <div className="glass neon-border p-4 flex flex-col" style={{ height: '100%', maxHeight: 'calc(100vh - 48px)', borderRadius: '2px' }}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-black uppercase tracking-wider" style={{ color: '#F1F5F9', letterSpacing: '0.05em' }}>Players</h2>
      </div>

      {/* Player Table */}
      <div className="mb-4">
        <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-2 text-xs font-light uppercase pb-2 mb-2" style={{ color: '#F1F5F9', borderBottom: '1px solid rgba(184, 167, 255, 0.3)' }}>
          <div>Player</div>
          <div>Bet</div>
          <div>Cash-out ↓</div>
          <div>Payout</div>
        </div>
        <div className="space-y-1 max-h-100 overflow-y-auto">
          {players.length === 0 ? (
            <div className="text-center text-sm py-4 font-light" style={{ color: 'rgba(241, 245, 249, 0.7)' }}>No players yet</div>
          ) : (
            players.map((player) => (
              <div key={player.id} className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-2 text-xs items-center py-1">
                <div className="flex items-center gap-2">
                  <span className="font-light" style={{ color: '#F1F5F9' }}>{player.name}</span>
                </div>
                <div className="font-light" style={{ color: '#F1F5F9' }}>{player.bet.toFixed(3)} mCHOG</div>
                <div className="font-light" style={{ color: player.cashOut ? '#B8A7FF' : 'rgba(241, 245, 249, 0.7)' }}>
                  {player.cashOut ? `${player.cashOut.toFixed(2)}x` : 'Pending'}
                </div>
                <div className="font-light" style={{ color: player.payout ? '#B8A7FF' : 'rgba(241, 245, 249, 0.7)' }}>
                  {player.payout ? `${player.payout.toFixed(4)} mCHOG` : 'Pending'}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Stats Footer */}
      <div className="mt-auto pt-4" style={{ borderTop: '1px solid rgba(184, 167, 255, 0.3)' }}>
        <div className="grid grid-cols-2 gap-2 text-xs font-light" style={{ color: '#F1F5F9' }}>
          <div>Round: <span style={{ color: '#B8A7FF' }}>{roundId || 'N/A'}</span></div>
          <div>Betting: <span style={{ color: '#B8A7FF' }}>{totalBetting.toFixed(2)} mCHOG</span></div>
          <div>Players: <span style={{ color: '#B8A7FF' }}>{playerCount}</span></div>
        </div>
      </div>
    </div>
  );
}

