'use client';

/**
 * Chart conventions (shared by every chart in the app):
 * one y-axis; thin bars with 4px rounded data ends; recessive grid; text in ink colors, never series colors;
 * a legend whenever there are 2+ series; a hover tooltip on every mark; a table view one click away.
 */
import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Segmented } from './ui';

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

const axis = { stroke: 'var(--ink-3)', fontSize: 12, tickLine: false, axisLine: false } as const;

export function ChartTooltip({ active, payload, label, unit, labelFormat }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-line bg-panel px-3 py-2 text-sm shadow-sm">
      <div className="mb-1 font-medium">{labelFormat ? labelFormat(label) : label}</div>
      {payload
        .filter((p: any) => p.value !== null && p.value !== undefined)
        .map((p: any) => (
          <div key={p.dataKey} className="flex items-center gap-2 text-ink-2">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.color ?? p.fill }} aria-hidden />
            <span className="flex-1">{p.name}</span>
            <span className="font-medium text-ink">
              {typeof p.value === 'number' ? (Number.isInteger(p.value) ? p.value : p.value.toFixed(1)) : p.value}
              {unit ? ` ${unit}` : ''}
            </span>
          </div>
        ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2">
      {items.map((i) => (
        <li key={i.label} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: i.color }} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** Chart / table switch so every figure is readable without color or a mouse. */
export function ChartOrTable({
  chart,
  table,
}: {
  chart: React.ReactNode;
  table: { columns: string[]; rows: (string | number)[][] };
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <div>
      <div className="flex justify-end px-4 pt-3">
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'chart', label: 'Chart' },
            { value: 'table', label: 'Table' },
          ]}
        />
      </div>
      {view === 'chart' ? (
        chart
      ) : (
        <div className="overflow-x-auto px-4 pb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-ink-3">
                {table.columns.map((c) => (
                  <th key={c} className="py-2 pr-4 font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  {r.map((c, j) => (
                    <td key={j} className="py-2 pr-4">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function StackedBars({
  data,
  xKey,
  series,
  unit,
  xFormat,
  height = 280,
}: {
  data: Record<string, any>[];
  xKey: string;
  series: { key: string; label: string }[];
  unit?: string;
  xFormat?: (v: any) => string;
  height?: number;
}) {
  return (
    <div className="px-2 pt-2 pb-4">
      <div className="px-2 pb-3">
        <Legend items={series.map((s, i) => ({ label: s.label, color: SERIES[i] }))} />
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }} barCategoryGap="28%">
          <CartesianGrid vertical={false} stroke="var(--line)" />
          <XAxis dataKey={xKey} {...axis} tickFormatter={xFormat} />
          <YAxis {...axis} width={40} unit={unit ? ` ${unit}` : undefined} />
          <Tooltip cursor={{ fill: 'var(--sunken)' }} content={<ChartTooltip unit={unit} labelFormat={xFormat} />} />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="a"
              fill={SERIES[i]}
              stroke="var(--panel)"
              strokeWidth={2}
              radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SimpleBars({
  data,
  xKey,
  yKey,
  label,
  unit,
  xFormat,
  height = 220,
  color = SERIES[0],
}: {
  data: Record<string, any>[];
  xKey: string;
  yKey: string;
  label: string;
  unit?: string;
  xFormat?: (v: any) => string;
  height?: number;
  color?: string;
}) {
  return (
    <div className="px-2 pt-2 pb-4">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }} barCategoryGap="30%">
          <CartesianGrid vertical={false} stroke="var(--line)" />
          <XAxis dataKey={xKey} {...axis} tickFormatter={xFormat} />
          <YAxis {...axis} width={40} allowDecimals={false} />
          <Tooltip cursor={{ fill: 'var(--sunken)' }} content={<ChartTooltip unit={unit} labelFormat={xFormat} />} />
          <Bar dataKey={yKey} name={label} fill={color} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
