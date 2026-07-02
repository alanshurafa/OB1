import Link from "next/link";
import { revalidatePath } from "next/cache";
import { fetchCrmContact, fetchCrmFieldEvidence, patchCrmContact, setCrmFieldLock, addCrmMethod, ApiError } from "@/lib/api";
import { requireSessionOrRedirect, getSession } from "@/lib/auth";
import { FormattedDate } from "@/components/FormattedDate";
import { EditableFactPanel } from "./EditableFactPanel";
import type { EditResult, EditableField } from "./EditableFactPanel";
import { AddMethodForm } from "./AddMethodForm";
import type { AddMethodResult } from "./AddMethodForm";
import { FieldEvidence } from "./FieldEvidence";
import type { CrmContactRecord, CrmEvidence } from "@/lib/types";

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

// Fields a human owner may edit inline. Everything else (e.g. owner_label) is
// read-only here. The set also gates the server action so an arbitrary column
// can never be smuggled into the patch body.
const EDITABLE_KEYS = new Set<string>([
  "display_name",
  "preferred_name",
  "given_name",
  "family_name",
  "pronouns",
  "job_title",
  "organization_name",
  "location",
  "relationship_note",
]);

async function editFieldAction(
  _prev: EditResult,
  formData: FormData
): Promise<EditResult> {
  "use server";
  const { apiKey } = await requireSessionOrRedirect();
  const id = String(formData.get("id") || "");
  const fieldKey = String(formData.get("field_key") || "");
  const expected = String(formData.get("expected_updated_at") || "") || null;
  const raw = String(formData.get("value") ?? "").trim();
  if (!id || !EDITABLE_KEYS.has(fieldKey)) {
    return { error: "That field can't be edited here." };
  }
  // Blank clears the field; the truth layer treats null as "unset".
  const value = raw === "" ? null : raw;

  try {
    await patchCrmContact(apiKey, id, {
      patch: { [fieldKey]: value },
      actor: "dashboard",
      origin: "manual",
      expected_updated_at: expected,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      console.error("[contact/edit] upstream", err.status, err.upstreamBody);
      if (err.status === 409) {
        return {
          stale: true,
          error:
            "This contact changed since you loaded it. Reload to pull the latest values, then edit again.",
        };
      }
      if (err.status === 403) {
        return { error: "This field is locked or restricted." };
      }
      return { error: err.message };
    }
    console.error("[contact/edit]", err);
    return { error: "Failed to save." };
  }

  revalidatePath(`/contacts/${id}`);
  return { ok: true };
}

async function lockFieldAction(
  _prev: EditResult,
  formData: FormData
): Promise<EditResult> {
  "use server";
  const { apiKey } = await requireSessionOrRedirect();
  const id = String(formData.get("id") || "");
  const fieldKey = String(formData.get("field_key") || "");
  // The form sends the desired next state, computed from the current lock.
  const locked = String(formData.get("locked") || "") === "true";
  if (!id || !EDITABLE_KEYS.has(fieldKey)) {
    return { error: "That field can't be locked here." };
  }

  try {
    await setCrmFieldLock(apiKey, id, {
      field_key: fieldKey,
      locked,
      actor: "dashboard",
    });
  } catch (err) {
    if (err instanceof ApiError) {
      console.error("[contact/lock] upstream", err.status, err.upstreamBody);
      if (err.status === 403) {
        return { error: "You can't change the lock on this field." };
      }
      return { error: err.message };
    }
    console.error("[contact/lock]", err);
    return { error: "Failed to update the lock." };
  }

  revalidatePath(`/contacts/${id}`);
  return { ok: true };
}

async function addMethodAction(
  _prev: AddMethodResult,
  formData: FormData
): Promise<AddMethodResult> {
  "use server";
  const { apiKey } = await requireSessionOrRedirect();
  const id = String(formData.get("id") || "");
  const rawType = String(formData.get("method_type") || "").trim();
  const customType = String(formData.get("method_type_custom") || "").trim();
  const methodType = rawType === "other" ? customType : rawType;
  const value = String(formData.get("value") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  const isPrimary = String(formData.get("is_primary") || "") === "true";
  if (!id) {
    return { error: "Missing contact." };
  }
  if (!methodType) {
    return { error: "Pick or name a method type." };
  }
  if (!value) {
    return { error: "Enter a value." };
  }

  try {
    await addCrmMethod(apiKey, id, {
      method_type: methodType,
      value,
      label: label || undefined,
      is_primary: isPrimary,
      actor: "dashboard",
    });
  } catch (err) {
    if (err instanceof ApiError) {
      console.error("[contact/add-method] upstream", err.status, err.upstreamBody);
      if (err.status === 403) {
        return { error: "You can't add a method to this contact." };
      }
      return { error: err.message };
    }
    console.error("[contact/add-method]", err);
    return { error: "Failed to add the method." };
  }

  revalidatePath(`/contacts/${id}`);
  return { ok: true };
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

  // Field evidence is a separate, optional read: an older brain may not expose
  // the route, so a failure here degrades to an empty panel rather than blanking
  // the whole contact page.
  let evidence: CrmEvidence[] = [];
  try {
    const res = await fetchCrmFieldEvidence(apiKey, id, {
      exclude_restricted: excludeRestricted,
    });
    evidence = res.evidence;
  } catch (err) {
    if (err instanceof ApiError) {
      console.error("[contact/evidence] upstream", err.status, err.upstreamBody);
    } else {
      console.error("[contact/evidence]", err);
    }
  }
  const fieldLabels: Record<string, string> = Object.fromEntries(
    DISPLAY_FIELDS.map(({ key, label }) => [String(key), label])
  );

  // Editable fields always render (even when empty, so an owner can fill them);
  // read-only fields only render when populated.
  const fieldData: EditableField[] = DISPLAY_FIELDS.map(({ key, label }) => {
    const raw = record[key];
    const value = raw === null || raw === undefined ? "" : String(raw);
    const prov = provenance[key as string];
    return {
      key: String(key),
      label,
      value,
      origin: prov?.origin,
      locked: prov?.locked,
      editable: EDITABLE_KEYS.has(key as string),
    };
  }).filter((f) => f.editable || f.value !== "");

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
      <EditableFactPanel
        contactId={record.id}
        updatedAt={record.updated_at}
        fields={fieldData}
        action={editFieldAction}
        lockAction={lockFieldAction}
      />

      {/* Field evidence */}
      <FieldEvidence evidence={evidence} labels={fieldLabels} />

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
                {method.label && <span className="text-xs text-text-muted">{method.label}</span>}
                {method.is_primary && <span className="text-xs text-violet">primary</span>}
              </li>
            ))}
          </ul>
        )}
        <AddMethodForm contactId={record.id} action={addMethodAction} />
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
