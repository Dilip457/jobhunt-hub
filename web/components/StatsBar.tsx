import type { RoleData, RoleMeta, StatusResponse } from "@/lib/types";
import { formatNumber, timeAgo, uniqueCompanies } from "@/lib/utils";
import { BriefcaseIcon, BuildingIcon, GlobeIcon, RefreshIcon } from "./Icons";

interface Props {
  data: RoleData;
  role: RoleMeta;
  status: StatusResponse | null;
}

export default function StatsBar({ data, role, status }: Props) {
  const sourceCount = Object.keys(data.sources ?? {}).length;
  const lastRun = status?.lastRunAt ?? data.generated_at;

  const items = [
    {
      label: "Open roles",
      value: formatNumber(data.count),
      icon: <BriefcaseIcon width={16} height={16} />,
      accent: role.accent,
    },
    {
      label: "Companies",
      value: formatNumber(uniqueCompanies(data.jobs)),
      icon: <BuildingIcon width={16} height={16} />,
      accent: "#38bdf8",
    },
    {
      label: "Sources",
      value: formatNumber(sourceCount),
      icon: <GlobeIcon width={16} height={16} />,
      accent: "#34d399",
    },
    {
      label: "Updated",
      value: timeAgo(lastRun),
      icon: <RefreshIcon width={16} height={16} />,
      accent: "#fbbf24",
    },
  ];

  return (
    <div className="stats">
      {items.map((item) => (
        <div className="stat-card" key={item.label}>
          <span className="stat-icon" style={{ color: item.accent, background: `${item.accent}1f` }}>
            {item.icon}
          </span>
          <div>
            <p className="stat-value">{item.value}</p>
            <p className="stat-label">{item.label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
