import React from "react";
import { PRIORITIES } from "@kanban/shared";
import type { BoardFilters, PriorityFilter } from "../state/filters.js";
import { isFilterActive } from "../state/filters.js";
import { SearchIcon } from "./Icons.js";

interface FilterBarProps {
  searchInput: string;
  filters: BoardFilters;
  assignees: readonly string[];
  onSearchInputChange: (value: string) => void;
  onPriorityChange: (priority: PriorityFilter) => void;
  onAssigneeChange: (assignee: string) => void;
  onClearFilters: () => void;
}

export function FilterBar({
  searchInput,
  filters,
  assignees,
  onSearchInputChange,
  onPriorityChange,
  onAssigneeChange,
  onClearFilters,
}: FilterBarProps): React.JSX.Element {
  const active = isFilterActive({ ...filters, q: searchInput });

  return (
    <section className="filter-bar" aria-label="Filter tasks">
      <div className="search-box">
        <span className="search-box__icon">
          <SearchIcon />
        </span>
        <input
          type="search"
          className="input search-box__input"
          placeholder="Search tasks by title..."
          value={searchInput}
          onChange={(e) => onSearchInputChange(e.target.value)}
          aria-label="Search tasks by title"
        />
      </div>

      <select
        className="select select--filter"
        value={filters.priority}
        onChange={(e) => onPriorityChange(e.target.value as PriorityFilter)}
        aria-label="Filter by priority"
      >
        <option value="all">All priorities</option>
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            Priority: {p}
          </option>
        ))}
      </select>

      <select
        className="select select--filter"
        value={filters.assignee}
        onChange={(e) => onAssigneeChange(e.target.value)}
        aria-label="Filter by assignee"
      >
        <option value="all">All assignees</option>
        <option value="__unassigned__">Unassigned</option>
        {assignees.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>

      {active && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onClearFilters}
        >
          Clear filters
        </button>
      )}

      {isFilterActive(filters) && (
        <span className="filter-bar__note">
          Drag &amp; drop disabled while filters are active
        </span>
      )}
    </section>
  );
}
