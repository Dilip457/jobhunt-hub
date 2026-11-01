import type { RoleData, StatusResponse } from "@/lib/types";
import { formatNumber, timeAgo, uniqueCompanies } from "@/lib/utils";

interface Props {
  data: RoleData;
  status: StatusResponse | null;
}

/** The role's four figures, set as type under the title rather than as tiles. */
export default function StatsBar({ data, status }: Props) {
  const sourceCount = Object.keys(data.sources ?? {}).length;
  const lastRun = status?.lastRunAt ?? data.generated_at;

  const items = [
    { label: "open jobs", value: formatNumber(data.count) },
    { label: "companies", value: formatNumber(uniqueCompanies(data.jobs)) },
    { label: "sources", value: formatNumber(sourceCount) },
    { label: "since the last scrape", value: timeAgo(lastRun).replace(/ ago$/, "") },
  ];

  return (
    <dl className="figures">
      {items.map((item) => (
        <div className="figure" key={item.label}>
          <dd>{item.value}</dd>
          <dt>{item.label}</dt>
        </div>
      ))}
    </dl>
  );
}
