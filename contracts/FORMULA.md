# Crash Game Formula Documentation

## Overview

This document describes the complete mathematical formula and algorithm used to generate verifiably fair crash game outcomes. The system uses a combination of on-chain entropy (Pyth Entropy) and off-chain server seed to create deterministic, unpredictable game results.

## Architecture

- **On-Chain**: Stores entropy random value (public) and server seed hash (commitment)
- **Off-Chain**: Derives all game parameters and simulates price movements
- **Verifiable**: Anyone can recompute the game outcome using the revealed server seed and entropy random

---

## Formula Components

### 1. Seed Derivation

**Location**: `crash-game-backend.ts` - `deriveSeed()` function

**Formula**:
```
derivedSeed = keccak256(
  vrfRandom || roundId || serverSeed || chainId
)
```

**Parameters**:
- `vrfRandom`: `uint256` - The entropy random value from Pyth Entropy (on-chain, public)
- `roundId`: `uint256` - The round identifier
- `serverSeed`: `string` - Secret server seed (revealed after game ends)
- `chainId`: `uint256` - Blockchain chain ID (e.g., 10143 for Monad testnet)

**Purpose**: Creates a deterministic seed that combines both on-chain randomness and server secret. This ensures neither party can predict the outcome alone.

**Where Used**: This seed is used to generate all random values (`r0`, `r1`, `r2`, etc.) via `getRandom(index)` function.

---

### 2. Random Value Generation

**Location**: `crash-game-backend.ts` - `getRandom(i)` function (inside `generateCrashGame`)

**Formula**:
```
randomValue = keccak256(derivedSeed || index) / maxUint256
```

**Returns**: A uniform random number in the range `[0, 1)`

**Parameters**:
- `i`: Index for the random value (0, 1, 2, 3, 4, 5, or i+10, i+20 for tick-by-tick randomness)

**Purpose**: Generates deterministic, uniform random values from the derived seed. Each index produces a different random value.

---

### 3. Crash Multiplier Calculation

**Location**: `crash-game-backend.ts` - Lines 86-111

**Step 1: Map Random to Probability**
```
r0 = getRandom(0)  // Uniform in [0, 1)
p = houseEdge + r0 * (1 - houseEdge)
```

**Parameters**:
- `r0`: Random value from index 0
- `houseEdge`: `0.015` (1.5% house edge)
- `p`: Probability value in range `[0.015, 1)`

**Step 2: Calculate Raw Multiplier**
```
rawMultiplier = (1 - houseEdge) / (1 - p)
```

**Mathematical Properties**:
- When `r0 = 0`: `p = 0.015` → `rawMultiplier = (0.985) / (0.985) = 1.00x` (instant crash)
- When `r0 → 1`: `p → 1` → `rawMultiplier → ∞` (approaches infinity)

**Step 3: Clamp and Round**
```
crashMultiplier = clamp(rawMultiplier, 1.00, 10000)
finalMultiplier = round(crashMultiplier, 2 decimal places)
```

**Parameters**:
- `crashMultiplier`: Clamped between 1.00x and 10000x
- `finalMultiplier`: Final crash point (rounded to 2 decimals)

**Where Used**: This is the maximum price the game can reach before crashing. It's also used as `maxPrice` in the trading simulation.

---

### 4. Trading Parameters (Derived from VRF)

**Location**: `crash-game-backend.ts` - Lines 113-129

All trading parameters are derived from VRF randomness to ensure verifiable fairness and game variety.

#### 4.1 Minimum Price (`minPrice`)

**Formula**:
```
r2 = getRandom(2)
minPrice = 0.40 + r2 * 0.30
```

**Range**: `[0.40, 0.70]`

**Parameters**:
- `r2`: Random value from index 2
- `0.40`: Minimum floor (40% of entry price)
- `0.30`: Range span

**Purpose**: Determines how low the price can drop during the game. Allows for 30-60% drawdowns, making the game more realistic and unpredictable.

**Where Used**: Clamps the price in the trading simulation (line 203).

---

#### 4.2 Trend Strength (`trendStrength`)

**Formula**:
```
r3 = getRandom(3)
trendStrength = 0.15 + r3 * 0.30
```

**Range**: `[0.15, 0.45]`

**Parameters**:
- `r3`: Random value from index 3
- `0.15`: Minimum trend strength (weak trend)
- `0.30`: Range span

**Purpose**: Controls how strongly the price is pulled toward the crash point. Higher values mean stronger trend (price moves more predictably toward crash). Lower values mean more random movement.

**Where Used**: In the direction bias calculation (line 195):
```
directionBias = (targetPrice - currentPrice) * trendStrength
```

---

#### 4.3 Volatility Base (`volatilityBase`)

**Formula**:
```
r4 = getRandom(4)
volatilityBase = 0.015 + r4 * 0.020
```

**Range**: `[0.015, 0.035]` (1.5% to 3.5% per tick)

**Parameters**:
- `r4`: Random value from index 4
- `0.015`: Minimum volatility (1.5% per tick)
- `0.020`: Range span

**Purpose**: Sets the base level of price volatility. Higher values mean more price movement per tick (more volatile). Lower values mean smoother, more stable price movements.

**Where Used**: In the volatility calculation (line 191):
```
volatility = volatilityBase * (1 - progress)^volatilityDecay
```

---

#### 4.4 Volatility Decay (`volatilityDecay`)

**Formula**:
```
r5 = getRandom(5)
volatilityDecay = 0.5 + r5 * 0.4
```

**Range**: `[0.5, 0.9]`

**Parameters**:
- `r5`: Random value from index 5
- `0.5`: Minimum decay rate (volatility decreases slowly)
- `0.4`: Range span

**Purpose**: Controls how quickly volatility decreases as the game progresses. Higher values mean volatility decreases faster (game becomes more stable near crash). Lower values mean volatility stays high longer.

**Where Used**: In the volatility calculation (line 191):
```
volatility = volatilityBase * (1 - progress)^volatilityDecay
```

**Example**:
- If `volatilityDecay = 0.7` and `progress = 0.5`:
  - `volatility = volatilityBase * (0.5)^0.7 ≈ volatilityBase * 0.62`
  - Volatility is reduced to ~62% of base at 50% progress

---

### 5. Game Duration

**Location**: `crash-game-backend.ts` - Lines 137-140

**Formula**:
```
r1 = getRandom(1)
baseDuration = 3000 ms
maxDuration = 30000 ms
duration = baseDuration + floor(r1 * (maxDuration - baseDuration))
totalTicks = ceil(duration / tickIntervalMs)
```

**Parameters**:
- `r1`: Random value from index 1
- `baseDuration`: `3000` ms (minimum game duration)
- `maxDuration`: `30000` ms (maximum game duration)
- `tickIntervalMs`: `100` ms (time between ticks)

**Range**: Game duration ranges from 3 seconds to 30 seconds (30 to 300 ticks)

**Purpose**: Randomizes game length to add variety and unpredictability.

---

### 6. Price Movement Simulation (Trading Simulation)

**Location**: `crash-game-backend.ts` - Lines 179-206

This is where the actual price movements are calculated tick-by-tick.

#### 6.1 Target Price Calculation

**Formula**:
```
progress = i / gameTicks  // Progress from 0 to 1
targetPrice = 1.00 + (maxPrice - 1.00) * progress^0.8
```

**Parameters**:
- `i`: Current tick index
- `gameTicks`: Total number of game ticks
- `maxPrice`: The final crash multiplier
- `0.8`: Exponential factor (slower initial growth, faster near end)

**Purpose**: Creates a target price that gradually trends toward the crash point. The `0.8` exponent means the target grows slowly at first, then accelerates.

**Example**:
- If `maxPrice = 5.0x`:
  - At `progress = 0.0`: `targetPrice = 1.00 + 4.00 * 0^0.8 = 1.00x`
  - At `progress = 0.5`: `targetPrice = 1.00 + 4.00 * 0.5^0.8 ≈ 2.74x`
  - At `progress = 1.0`: `targetPrice = 1.00 + 4.00 * 1.0^0.8 = 5.00x`

---

#### 6.2 Volatility Calculation

**Formula**:
```
volatility = volatilityBase * (1 - progress)^volatilityDecay
```

**Parameters**:
- `volatilityBase`: Base volatility (1.5% - 3.5% per tick)
- `progress`: Game progress (0 to 1)
- `volatilityDecay`: Decay rate (0.5 - 0.9)

**Purpose**: Volatility decreases as the game progresses, making price movements more stable near the crash point. This prevents wild swings when close to the crash.

**Example**:
- If `volatilityBase = 0.02` (2%) and `volatilityDecay = 0.7`:
  - At `progress = 0.0`: `volatility = 0.02 * 1.0^0.7 = 0.02` (2%)
  - At `progress = 0.5`: `volatility = 0.02 * 0.5^0.7 ≈ 0.0124` (1.24%)
  - At `progress = 0.9`: `volatility = 0.02 * 0.1^0.7 ≈ 0.004` (0.4%)

---

#### 6.3 Price Change Calculation

**Formula**:
```
r1 = getRandom(i + 10)  // Random for this tick
r2 = getRandom(i + 20)  // Random for trend (currently unused)

directionBias = (targetPrice - currentPrice) * trendStrength
randomMove = (r1 - 0.5) * 2  // Maps [0,1) to [-1, +1]
priceChange = directionBias + (randomMove * volatility)
```

**Parameters**:
- `targetPrice`: The target price for this tick (trends toward crash)
- `currentPrice`: Current price from previous tick
- `trendStrength`: How strongly price is pulled toward target (0.15 - 0.45)
- `r1`: Random value for this tick
- `volatility`: Current volatility level

**Purpose**: 
- `directionBias`: Pulls price toward the target (trend effect)
- `randomMove * volatility`: Adds random movement (volatility effect)
- Combined: Creates a random walk with trend bias

**Example**:
- If `targetPrice = 2.0x`, `currentPrice = 1.5x`, `trendStrength = 0.3`, `volatility = 0.02`:
  - `directionBias = (2.0 - 1.5) * 0.3 = 0.15` (15% upward bias)
  - If `r1 = 0.7`: `randomMove = (0.7 - 0.5) * 2 = 0.4`
  - `priceChange = 0.15 + (0.4 * 0.02) = 0.158` (15.8% increase)
  - New price: `1.5 * 1.158 = 1.737x`

---

#### 6.4 Price Update

**Formula**:
```
currentPrice = currentPrice * (1 + priceChange)
currentPrice = clamp(currentPrice, minPrice, maxPrice)
roundedMultiplier = round(currentPrice, 2 decimal places)
```

**Parameters**:
- `currentPrice`: Price from previous tick
- `priceChange`: Calculated price change (can be positive or negative)
- `minPrice`: Minimum price floor (0.40x - 0.70x)
- `maxPrice`: Maximum price (final crash multiplier)

**Purpose**: 
- Updates price based on calculated change
- Clamps to valid range (prevents going below floor or above crash point)
- Rounds to 2 decimal places for display

**Where Used**: This becomes the `currentValue` and `bar.close` in the game update.

---

## Complete Formula Flow

### Phase 1: Initialization
1. Derive seed: `derivedSeed = keccak256(vrfRandom || roundId || serverSeed || chainId)`
2. Generate random values: `r0, r1, r2, r3, r4, r5` from derived seed
3. Calculate crash multiplier: `finalMultiplier` from `r0`
4. Derive trading parameters: `minPrice, trendStrength, volatilityBase, volatilityDecay` from `r2, r3, r4, r5`
5. Calculate game duration: `totalTicks` from `r1`

### Phase 2: Betting Phase
- Generate betting ticks (gameState = 1)
- Price stays at 1.00x
- Duration: 5 seconds (50 ticks at 100ms interval)

### Phase 3: Trading Phase
For each tick `i` from 0 to `gameTicks`:
1. Calculate progress: `progress = i / gameTicks`
2. Calculate target price: `targetPrice = 1.00 + (maxPrice - 1.00) * progress^0.8`
3. Calculate volatility: `volatility = volatilityBase * (1 - progress)^volatilityDecay`
4. Get random values: `r1 = getRandom(i + 10)`, `r2 = getRandom(i + 20)`
5. Calculate price change: `priceChange = directionBias + (randomMove * volatility)`
6. Update price: `currentPrice = currentPrice * (1 + priceChange)`
7. Clamp price: `currentPrice = clamp(currentPrice, minPrice, maxPrice)`
8. Round: `roundedMultiplier = round(currentPrice, 2 decimals)`
9. Check crash: If `roundedMultiplier >= finalMultiplier`, game ends

### Phase 4: Crash
- Price hits or exceeds `finalMultiplier`
- Game state changes to 3 (CRASHED)
- Final update sent with crash information

---

## Parameter Summary Table

| Parameter | Source | Range | Purpose | Location |
|:----------|:-------|:------|:--------|:---------|
| `vrfRandom` | Pyth Entropy (on-chain) | `uint256` | Primary randomness source | Contract storage |
| `serverSeed` | Server (off-chain) | `hex string` | Secret seed for commit-reveal | Revealed after game |
| `roundId` | Contract counter | `uint256` | Round identifier | Contract storage |
| `chainId` | Network config | `uint256` | Blockchain ID | Network config |
| `r0` | `getRandom(0)` | `[0, 1)` | Crash multiplier calculation | Line 86 |
| `r1` | `getRandom(1)` | `[0, 1)` | Game duration | Line 87 |
| `r2` | `getRandom(2)` | `[0, 1)` | Minimum price | Line 114 |
| `r3` | `getRandom(3)` | `[0, 1)` | Trend strength | Line 115 |
| `r4` | `getRandom(4)` | `[0, 1)` | Volatility base | Line 116 |
| `r5` | `getRandom(5)` | `[0, 1)` | Volatility decay | Line 117 |
| `houseEdge` | Constant | `0.015` | House edge (1.5%) | Line 89 |
| `finalMultiplier` | Calculated from `r0` | `[1.00, 10000]` | Crash point | Line 111 |
| `minPrice` | Calculated from `r2` | `[0.40, 0.70]` | Price floor | Line 120 |
| `trendStrength` | Calculated from `r3` | `[0.15, 0.45]` | Trend pull strength | Line 123 |
| `volatilityBase` | Calculated from `r4` | `[0.015, 0.035]` | Base volatility | Line 126 |
| `volatilityDecay` | Calculated from `r5` | `[0.5, 0.9]` | Volatility decay rate | Line 129 |
| `baseDuration` | Constant | `3000 ms` | Minimum game duration | Line 137 |
| `maxDuration` | Constant | `30000 ms` | Maximum game duration | Line 138 |
| `tickIntervalMs` | Constant | `100 ms` | Time between ticks | Line 236 |
| `bettingDuration` | Constant | `5000 ms` | Betting phase duration | Line 144 |

---

## Key Properties

### Verifiability
- All parameters are deterministic from `vrfRandom` + `serverSeed` + `roundId` + `chainId`
- Anyone can recompute the entire game after server seed is revealed
- No hidden parameters or server manipulation possible

### Unpredictability
- `vrfRandom` is public but `serverSeed` is secret until reveal
- Players cannot predict outcome during the game
- Server cannot manipulate outcome (seed committed before randomness)

### Fairness
- House edge is fixed at 1.5%
- Instant crashes (1.00x) are possible
- Distribution follows standard crash game formula
- Trading parameters add variety without affecting fairness

### Trading Simulation
- Price can move up or down (realistic trading experience)
- Volatility decreases over time (more stable near crash)
- Trend bias pulls price toward crash point
- Price is clamped to prevent extreme values

---

## Example Calculation

Let's trace through a complete example:

**Inputs**:
- `vrfRandom = 1234567890123456789012345678901234567890123456789012345678901234`
- `roundId = 5`
- `serverSeed = "a1b2c3d4e5f6..."`
- `chainId = 10143`

**Step 1: Derive Seed**
```
derivedSeed = keccak256(vrfRandom || roundId || serverSeed || chainId)
```

**Step 2: Generate Random Values**
```
r0 = getRandom(0) = 0.234567
r1 = getRandom(1) = 0.789012
r2 = getRandom(2) = 0.456789
r3 = getRandom(3) = 0.123456
r4 = getRandom(4) = 0.890123
r5 = getRandom(5) = 0.567890
```

**Step 3: Calculate Crash Multiplier**
```
p = 0.015 + 0.234567 * 0.985 = 0.246
rawMultiplier = 0.985 / (1 - 0.246) = 1.307
finalMultiplier = round(1.307, 2) = 1.31x
```

**Step 4: Derive Trading Parameters**
```
minPrice = 0.40 + 0.456789 * 0.30 = 0.537x
trendStrength = 0.15 + 0.123456 * 0.30 = 0.187
volatilityBase = 0.015 + 0.890123 * 0.020 = 0.033 (3.3%)
volatilityDecay = 0.5 + 0.567890 * 0.4 = 0.727
```

**Step 5: Calculate Game Duration**
```
duration = 3000 + floor(0.789012 * 27000) = 24270 ms
totalTicks = ceil(24270 / 100) = 243 ticks
```

**Step 6: Simulate Price Movements**
For each tick, price moves based on:
- Target price (trends toward 1.31x)
- Volatility (decreases over time)
- Random movement (up or down)
- Clamped between 0.537x and 1.31x

---

## Verification

After a game ends, anyone can verify the outcome by:

1. Reading `entropyRandom` from the contract (on-chain)
2. Reading `serverSeed` from the reveal event (on-chain)
3. Reading `roundId` from the contract (on-chain)
4. Using the chain ID (public)
5. Recomputing all parameters using the formulas above
6. Regenerating the game ticks
7. Comparing with the actual game outcome

If everything matches, the game was fair and verifiable.

---

## Notes

- All random values are deterministic from the seed
- The formula ensures instant crashes (1.00x) are possible
- Trading parameters add game variety while maintaining fairness
- Price movements are realistic (can go up or down)
- The system is fully verifiable after server seed reveal

