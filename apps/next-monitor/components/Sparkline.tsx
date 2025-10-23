"use client";
import React from 'react';

type Props = {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string | null;
};

export default function Sparkline({
  data,
  width = 160,
  height = 40,
  stroke = '#2563eb',
  fill = null,
}: Props) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1e-9;

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const path = `M ${points[0]} L ${points.slice(1).join(' ')}`;

  const areaPath = `M 0,${height} L ${points.join(' ')} L ${width},${height} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {fill && <path d={areaPath} fill={fill} opacity={0.15} />}
      <path d={path} fill="none" stroke={stroke} strokeWidth={2} />
    </svg>
  );
}
