import React from "react";
import { COLUMNS } from "@kanban/shared";

export function BoardSkeleton(): React.JSX.Element {
  return (
    <div className="board-grid" aria-label="Loading Kanban board" aria-busy="true">
      {COLUMNS.map((col) => (
        <div key={col.id} className="column column--skeleton">
          <div className="column__header">
            <div className="skeleton-pill skeleton-pill--title" />
            <div className="skeleton-pill skeleton-pill--count" />
          </div>
          <div className="column__list">
            {[1, 2, 3].map((n) => (
              <div key={n} className="skeleton-card">
                <div className="skeleton-line skeleton-line--long" />
                <div className="skeleton-line skeleton-line--short" />
                <div className="skeleton-meta">
                  <div className="skeleton-pill" />
                  <div className="skeleton-pill" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
