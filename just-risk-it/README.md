# Just Risk It - Crash Game Frontend

A real-time crash game frontend built with React, Vite, Tailwind CSS, and lightweight-charts.

## Features

- 🎮 Real-time crash game visualization
- 📊 Interactive chart using lightweight-charts
- 💰 Betting interface
- 🔄 WebSocket connection with auto-reconnect
- 🎨 Modern UI with Tailwind CSS
- 📱 Responsive design

## Prerequisites

- Node.js 18+ and npm
- The crash game server running (see `../contracts/scripts/crash-game-server.ts`)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file (optional, defaults to `ws://localhost:6969`):
```bash
VITE_WS_URL=ws://localhost:6969
```

3. Start the development server:
```bash
npm run dev
```

4. Make sure the crash game server is running:
```bash
cd ../contracts
npm run crash-game
```

## Usage

1. Open the app in your browser (usually `http://localhost:5173`)
2. Wait for the connection to establish (green indicator)
3. When a new game starts:
   - Place your bet during the BETTING phase
   - Watch the multiplier grow during the RUNNING phase
   - Cash out before it crashes, or wait for the crash
4. View game results and verification data after each round

## Project Structure

```
src/
├── components/
│   ├── CrashGame.tsx       # Main game component
│   └── CrashGameChart.tsx  # Chart component using lightweight-charts
├── hooks/
│   └── useWebSocket.ts     # WebSocket connection hook
├── App.tsx                 # Root component
└── index.css              # Global styles with Tailwind
```

## WebSocket Protocol

The frontend connects to the crash game server via WebSocket and receives:

### Status Messages
```json
{
  "type": "status",
  "status": "preparing_game" | "prepared" | "game_started" | "revealed",
  "roundId": 1,
  "message": "...",
  "serverSeed": "...",
  "txHash": "..."
}
```

### Update Messages
```json
{
  "type": "update",
  "currentValue": 100000,
  "bar": {
    "open": 1.00,
    "high": 1.50,
    "low": 1.00,
    "close": 1.50,
    "time": { "year": 2024, "month": 1, "day": 1 }
  },
  "gameState": 2,
  "nextGameNoMoreBetsAt": 0
}
```

### Game States
- `1` = BETTING (players can place bets)
- `2` = RUNNING (game is active, players can cash out)
- `3` = CRASHED (game ended)

## Technologies

- **React 19** - UI framework
- **Vite** - Build tool
- **Tailwind CSS 4** - Styling
- **lightweight-charts** - Charting library
- **TypeScript** - Type safety

## Development

```bash
# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Lint code
npm run lint
```

## Configuration

The WebSocket URL can be configured via:
1. Environment variable: `VITE_WS_URL`
2. Default: `ws://localhost:6969`

## Notes

- The chart automatically scrolls to show the latest data
- Chart data is limited to the last 1000 points for performance
- The connection automatically reconnects if disconnected (up to 30 retries)
- Game state is synchronized with the server in real-time
