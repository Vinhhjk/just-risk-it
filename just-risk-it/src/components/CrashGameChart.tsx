import { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi, type CandlestickData, type Time } from 'lightweight-charts';

interface CrashGameChartProps {
  data: Array<{
    time: Time;
    open: number;
    high: number;
    low: number;
    close: number;
  }>;
  currentMultiplier: number;
  gameState: number; // 1 = BETTING, 2 = RUNNING, 3 = CRASHED
  status?: string; // Status text to display in center
}

// Helper to extract numeric timestamp from Time type
function getNumericTime(time: Time): number {
  if (typeof time === 'number') return time;
  if (typeof time === 'string') return parseInt(time, 10);
  // BusinessDay - convert to timestamp (approximate)
  return Date.now() / 1000;
}

export function CrashGameChart({ data, gameState }: CrashGameChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Create chart with Space Expo theme
    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight || 600,
      layout: {
        background: { color: 'rgba(0, 0, 0, 0.4)' },
        textColor: '#F1F5F9',
      },
      grid: {
        vertLines: { color: 'rgba(184, 167, 255, 0.1)', visible: true },
        horzLines: { color: 'rgba(184, 167, 255, 0.1)', visible: true },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: 'rgba(184, 167, 255, 0.3)',
        rightOffset: 0,
        rightBarStaysOnScroll: false,
      },
      rightPriceScale: {
        borderColor: 'rgba(184, 167, 255, 0.3)',
        textColor: '#F1F5F9',
      },
    });

    chartRef.current = chart;

    // Create candlestick series with green/red colors
    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981', // Green for up candles
      downColor: '#ef4444', // Red for down candles
      borderUpColor: '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });
    
    // Ensure wicks are visible with proper styling
    candlestickSeries.applyOptions({
      wickVisible: true,
      borderVisible: true,
    });

    seriesRef.current = candlestickSeries;

    // Handle resize
    const handleResize = () => {
      if (chartContainerRef.current && chart) {
        chart.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight || 600,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, [gameState]);

  // Update series data
  useEffect(() => {
    if (!seriesRef.current) return;

    // Don't initialize with dummy data - wait for real data
    if (data.length === 0) {
      seriesRef.current.setData([]);
      return;
    }

    // Convert data to CandlestickData format and ensure it's sorted and unique by time
    const candlestickData: CandlestickData[] = data
      .map((point) => {
        // Ensure high is at least as high as open and close, and low is at least as low
        const high = Math.max(point.high, point.open, point.close);
        const low = Math.min(point.low, point.open, point.close);
        
        // If high equals low (or very close), add a small range to make wicks visible
        const minWickSize = 0.001; // Small minimum wick size
        const adjustedHigh = high === low ? high + minWickSize : high;
        const adjustedLow = high === low ? low - minWickSize : low;
        
        return {
          time: point.time,
          open: point.open,
          high: adjustedHigh,
          low: adjustedLow,
          close: point.close,
        };
      })
      .sort((a, b) => {
        // Sort by time
        return getNumericTime(a.time) - getNumericTime(b.time);
      })
      .filter((point, index, array) => {
        // Remove duplicates - keep only first occurrence of each timestamp
        if (index === 0) return true;
        const prevTime = getNumericTime(array[index - 1].time);
        const currTime = getNumericTime(point.time);
        return currTime > prevTime;
      });

    seriesRef.current.setData(candlestickData);
    // Keep green/red colors regardless of game state
  }, [data, gameState]);

  // Center the chart view
  useEffect(() => {
    if (!chartRef.current || data.length === 0) return;
    
    // Wait a bit for chart to render, then center it
    setTimeout(() => {
      if (!chartRef.current) return;
      const timeScale = chartRef.current.timeScale();
      const dataLength = data.length;
      
      if (dataLength > 0) {
        // Scroll to show data starting from around 30-40% to center the view
        const scrollPosition = Math.max(0, Math.floor(dataLength * 0.35));
        timeScale.scrollToPosition(scrollPosition, false);
      }
    }, 100);
  }, [data]);

  return (
    <div 
      className="w-full h-full"
      style={{ position: 'relative', overflow: 'hidden', height: '100%', borderRadius: '2px' }}
    >
      <div ref={chartContainerRef} className="w-full h-full" style={{ height: '100%' }} />
    </div>
  );
}

