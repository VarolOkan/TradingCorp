// frontend/src/components/compare/CorrelationMatrix.tsx
// Phase 5: pairwise Pearson correlation of daily returns across the compared
// tickers. Color-coded cells (green = positively correlated, red = negatively).
import { correlationMatrix } from './compareUtils';

export interface CorrelationMatrixProps {
  /** ticker -> return series (already computed). */
  returns: Record<string, number[]>;
  width?: number;
}

function corrColor(v: number): string {
  // v in [-1, 1]. Positive -> teal, negative -> rose, near 0 -> slate.
  const a = Math.abs(v);
  if (v >= 0) {
    return `rgba(52, 211, 153, ${(0.12 + a * 0.5).toFixed(2)})`;
  }
  return `rgba(248, 113, 113, ${(0.12 + a * 0.5).toFixed(2)})`;
}

export function CorrelationMatrix({ returns }: CorrelationMatrixProps) {
  const { tickers, matrix } = correlationMatrix(returns);
  if (tickers.length < 2) {
    return (
      <div className="corr-matrix-empty" data-testid="corr-empty">
        Need at least 2 tickers to compute correlation.
      </div>
    );
  }
  return (
    <table className="corr-matrix" data-testid="corr-matrix">
      <thead>
        <tr>
          <th className="corr-corner" data-testid="corr-corner" />
          {tickers.map((t) => (
            <th key={t} data-testid={`corr-col-${t}`}>
              {t}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {tickers.map((rowT, i) => (
          <tr key={rowT}>
            <th data-testid={`corr-row-${rowT}`}>{rowT}</th>
            {tickers.map((colT, j) => {
              const v = matrix[i]![j]!;
              return (
                <td
                  key={colT}
                  className="corr-cell"
                  style={{ background: corrColor(v) }}
                  data-testid={`corr-${rowT}-${colT}`}
                  data-value={v.toFixed(2)}
                >
                  {v.toFixed(2)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export { corrColor };
