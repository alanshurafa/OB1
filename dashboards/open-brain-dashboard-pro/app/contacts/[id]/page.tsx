import Link from "next/link";
import { fetchCrmContact, ApiError } from "@/lib/api";
import { requireSessionOrRedirect, getSession } from "@/lib/auth";
import { FormattedDate } from "@/components/FormattedDate";
import type { CrmContactRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

const DISPLAY_FIELDS: Array<{ key: keyof CrmContactRecord; label: string }> = [
  { key: "display_name", label: "Name" },
  { key: "preferred_name", label: "Preferred name" },
  { key: "given_name", label: "Given name" },
  { key: "family_name", label: "Family name" },
  { key: "pronouns", label: "Pronouns" },
  { key: "job_title", label: "Title" },
  { key: "organization_name", label: "Organization" },
  { key: "location", label: "Location" },
  { key: "relationship_note", label: "Note" },
  { key: "owner_label", label: "Owner" },
];

function OriginChip({ origin, locked }: { origin?: string; locked?: boolean }) {
  if (!origin && !locked) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border border-border bg-bg-elevated text-text-muted">
      {origin || "manual"}
      {locked && <span title="Locked" className="text-amber">🔒</span>}
    </span>
  );
}

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { apiKey } = await requireSessionOrRedirect();
  const session = await getSession();
  const excludeRestricted = session.restrictedUnlocked !== true;
  const { id } = await params;

  let bundle;
  try {
    bundle = await fetchCrmContact(apiKey, id, excludeRestricted);
  } catch (err) {
    if (err instanceof ApiError) {
      console.error("[contact] upstream", err.status, err.upstreamBody);
      if (err.status === 403) {
        return (
          <div className="space-y-4">
            <Link href="/contacts" className="text-sm text-text-muted hover:text-violet transition-colors">← Contacts</Link>
            <div className="bg-bg-surface border border-border rounded-lg p-8 text-center">
              <p className="text-text-secondary">This contact is restricted.</p>
              <p className="text-text-muted text-sm mt-1">Unlock restricted content to view it.</p>
            </div>
          </div>
        );
      }
      if (err.status === 404) {
        return (
          <div className="space-y-4">
            <Link href="/contacts" className="text-sm text-text-muted hover:text-violet transition-colors">← Contacts</Link>
            <p className="text-text-secondary">Contact not found.</p>
          </div>
        );
      }
    } else {
      console.error("[contact]", err);
    }
    return (
      <div className="space-y-4">
        <Link href="/contacts" className="text-sm text-text-muted hover:text-violet transition-colors">← Contacts</Link>
        <p className="text-danger text-sm">Failed to load contact.</p>
      </div>
    );
  }

  const { record, methods, aliases } = bundle;
  const provenance = record.field_provenance || {};

  return (
    <div className="space-y-6">
      <div>
        <Link href="/contacts" className="text-sm text-text-muted hover:text-violet transition-colors">← Contacts</Link>
        <div className="flex items-center gap-3 mt-2">
          <h1 className="text-2xl font-semibold">{record.display_name}</h1>
          {record.lifecycle_status === "archived" && (
            <span className="text-xs px-2 py-0.5 rounded border border-border bg-bg-elevated text-text-muted">archived</span>
          )}
        </div>
        {(record.job_title || record.organization_name) && (
          <p className="text-text-secondary text-sm mt-1">
            {[record.job_title, record.organization_name].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>

      {/* Fact panel */}
      <section className="bg-bg-surface border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary">Fields</h2>
          <p className="text-text-muted text-xs">Each field shows its origin; a lock blocks all writes until unlocked.</p>
        </div>
        <dl className="divide-y divide-border-subtle">
          {DISPLAY_FIELDS.map(({ key, label }) => {
            const value = record[key];
            if (value === null || value === undefined || value === "") return null;
            const prov = provenance[key as string];
            return (
              <div key={String(key)} className="px-4 py-3 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <dt className="text-text-muted text-xs uppercase tracking-wider">{label}</dt>
                  <dd className="text-text-primary text-sm mt-0.5 break-words">{String(value)}</dd>
                </div>
                <OriginChip origin={prov?.origin} locked={prov?.locked} />
              </div>
            );
          })}
        </dl>
      </section>

      {/* Methods */}
      <section className="bg-bg-surface border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary">Contact methods</h2>
        </div>
        {methods.length === 0 ? (
          <p className="px-4 py-6 text-center text-text-muted text-sm">No methods.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {methods.map((method) => (
              <li key={method.id} className="px-4 py-3 flex items-center gap-3 text-sm">
                <span className="text-text-muted text-xs uppercase tracking-wider w-16">{method.method_type}</span>
                <span className="text-text-primary flex-1 break-words">{method.value}</span>
                {method.is_primary && <span className="text-xs text-violet">primary</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Aliases */}
      {aliases.length > 0 && (
        <section className="bg-bg-surface border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-text-primary">Aliases</h2>
          </div>
          <ul className="divide-y divide-border-subtle">
            {aliases.map((alias) => (
              <li key={alias.id} className="px-4 py-3 text-sm text-text-primary">{alias.alias}</li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-text-muted text-xs">
        Created <FormattedDate date={record.created_at} /> · Updated <FormattedDate date={record.updated_at} />
      </p>
    </div>
  );
}
