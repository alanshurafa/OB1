import Link from "next/link";
import { fetchCrmProposals, ApiError } from "@/lib/api";
import { requireSessionOrRedirect } from "@/lib/auth";
import { FormattedDate } from "@/components/FormattedDate";

export const dynamic = "force-dynamic";

const STATUSES = ["open", "accepted", "rejected", "all"];

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "open"
      ? "text-violet border-violet/30 bg-violet-surface"
      : status === "accepted"
        ? "text-emerald border-emerald/30 bg-emerald/10"
        : "text-text-muted border-border bg-bg-elevated";
  return <span className={`inline-block text-xs px-2 py-0.5 rounded border ${color}`}>{status}</span>;
}

export default async function ProposalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { apiKey } = await requireSessionOrRedirect();
  const params = await searchParams;
  const page = parseInt(params.page || "1", 10);
  const status = params.status || "open";

  let data;
  try {
    data = await fetchCrmProposals(apiKey, { page, per_page: 25, status });
  } catch (err) {
    if (err instanceof ApiError) {
      console.error("[proposals] upstream", err.status, err.upstreamBody);
    } else {
      console.error("[proposals]", err);
    }
    const safeMessage = err instanceof ApiError ? err.message : "";
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Proposals</h1>
        <p className="text-danger text-sm">Failed to load proposals. {safeMessage}</p>
      </div>
    );
  }

  const totalPages = Math.ceil(data.total / data.per_page);

  function pageUrl(p: number) {
    const sp = new URLSearchParams();
    sp.set("page", String(p));
    sp.set("status", status);
    return `/proposals?${sp.toString()}`;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold mb-1">Proposals</h1>
        <p className="text-text-secondary text-sm">
          Machine-suggested changes awaiting a human decision. {data.total.toLocaleString()} {status !== "all" ? status : ""} total.
        </p>
      </div>

      <div className="flex gap-1.5">
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/proposals?status=${s}`}
            className={`px-3 py-1.5 text-sm rounded-lg border transition-colors capitalize ${
              status === s ? "bg-violet-surface text-violet border-violet/20" : "bg-bg-elevated border-border text-text-secondary hover:bg-bg-hover"
            }`}
          >
            {s}
          </Link>
        ))}
      </div>

      <div className="bg-bg-surface border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-text-muted text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-3 font-medium">Field</th>
              <th className="text-left px-4 py-3 font-medium">Change</th>
              <th className="text-left px-4 py-3 font-medium w-24">Origin</th>
              <th className="text-left px-4 py-3 font-medium w-24">Status</th>
              <th className="text-left px-4 py-3 font-medium w-40">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {data.data.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-text-muted">
                  No {status !== "all" ? status : ""} proposals.
                </td>
              </tr>
            )}
            {data.data.map((proposal) => (
              <tr key={proposal.id} className="hover:bg-bg-hover transition-colors">
                <td className="px-4 py-3">
                  <Link
                    href={`/contacts/${proposal.contact_id}`}
                    className="text-text-primary hover:text-violet transition-colors font-medium"
                  >
                    {proposal.field_key}
                  </Link>
                  <span className="text-text-muted text-xs block">{proposal.target_kind}</span>
                </td>
                <td className="px-4 py-3">
                  <span className="text-text-muted line-through">{proposal.current_value || "∅"}</span>
                  <span className="text-text-muted mx-1.5">→</span>
                  <span className="text-text-primary">{proposal.proposed_value || "∅"}</span>
                </td>
                <td className="px-4 py-3 text-text-secondary text-xs">{proposal.origin}</td>
                <td className="px-4 py-3"><StatusBadge status={proposal.status} /></td>
                <td className="px-4 py-3 text-text-muted text-xs whitespace-nowrap">
                  <FormattedDate date={proposal.created_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-text-muted">Page {page} of {totalPages}</p>
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={pageUrl(page - 1)} className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors">Previous</Link>
            )}
            {page < totalPages && (
              <Link href={pageUrl(page + 1)} className="px-3 py-1.5 text-sm bg-bg-elevated border border-border rounded-lg text-text-secondary hover:bg-bg-hover transition-colors">Next</Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
