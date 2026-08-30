// -----------------------------------------------------------------------------
// email/resend.ts
// Sending mail through Resend. fetch, no SDK — same style as
// negotiation/openai.ts, so there is nothing new to install.
//
// OPTIONAL, like Firebase: without RESEND_API_KEY the server still boots and
// these calls report themselves as unavailable instead of throwing. What must
// NOT happen is Volta telling a carrier the confirmation is on its way while
// nothing was sent, so the caller is expected to check the result and act on it.
// -----------------------------------------------------------------------------
const ENDPOINT = "https://api.resend.com/emails";

// Don't hold a phone call hostage to an HTTP request.
const TIMEOUT_MS = 8000;

function apiKey(): string {
  return (process.env.RESEND_API_KEY || "").trim();
}

// Must be an address on a domain verified in Resend. Friendly names are fine:
// "Volta <volta@yourdomain.com>".
function from(): string {
  return (process.env.RESEND_FROM || "").trim();
}

export function emailReady(): boolean {
  return Boolean(apiKey() && from());
}

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export async function sendEmail(msg: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendResult> {
  if (!emailReady()) {
    return { ok: false, error: "email_not_configured" };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: from(),
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
      signal: ctrl.signal,
    });

    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Resend puts the useful part in body.message.
      return { ok: false, error: body?.message || `resend_http_${res.status}` };
    }
    return { ok: true, id: String(body?.id || "") };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.name === "AbortError" ? "resend_timeout" : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}
