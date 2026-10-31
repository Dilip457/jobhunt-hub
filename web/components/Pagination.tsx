import { pageItems } from "@/lib/utils";

interface Props {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}

export default function Pagination({ page, pageCount, pageSize, total, onChange }: Props) {
  if (total === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav className="pager" aria-label="Job pages">
      <p className="pager-range">
        Showing {first}–{last} of {total} jobs
      </p>
      {pageCount > 1 ? (
        <div className="pager-buttons">
          <button
            type="button"
            className="pager-btn pager-step"
            onClick={() => onChange(page - 1)}
            disabled={page === 1}
            aria-label="Previous page"
          >
            ‹<span className="pager-step-label"> Prev</span>
          </button>
          {pageItems(page, pageCount).map((item, index) =>
            item === "gap" ? (
              <span className="pager-gap" key={`gap-${index}`} aria-hidden>
                …
              </span>
            ) : (
              <button
                type="button"
                key={item}
                className={`pager-btn ${item === page ? "is-current" : ""}`}
                onClick={() => onChange(item)}
                aria-label={`Page ${item}`}
                aria-current={item === page ? "page" : undefined}
              >
                {item}
              </button>
            ),
          )}
          <button
            type="button"
            className="pager-btn pager-step"
            onClick={() => onChange(page + 1)}
            disabled={page === pageCount}
            aria-label="Next page"
          >
            <span className="pager-step-label">Next </span>›
          </button>
        </div>
      ) : null}
    </nav>
  );
}
