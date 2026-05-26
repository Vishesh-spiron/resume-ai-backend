// src/controllers/humanReviewController.js
// ─────────────────────────────────────────────────────────────────────────────
// Receives multipart POST from Flutter (PDF bytes + form fields).
// Sends admin email with PDF attachment via Resend HTTPS API.
// Works on Render free tier — no SMTP, no port blocking.
// ─────────────────────────────────────────────────────────────────────────────

const { getResendClient } = require('../config/emailer');

async function submitHumanReview(req, res) {
  const { requestId } = req;

  // ── 1. Extract form fields ─────────────────────────────────────────────────
  const {
    userName   = 'Unknown',
    userEmail  = '',
    targetRole = 'Not specified',
    notes      = 'None',
    resumeText = '',
  } = req.body ?? {};

  if (!userEmail) {
    return res.status(400).json({ error: 'Missing required field: userEmail' });
  }

  // ── 2. Build attachment ────────────────────────────────────────────────────
  // Resend accepts Buffer directly in the content field
  const attachments = [];
  if (req.file) {
    const safeName = (req.file.originalname || 'resume.pdf')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    attachments.push({
      filename: safeName,
      content:  req.file.buffer,   // Buffer from multer memoryStorage
    });
    console.log(`[${requestId}] PDF attached | ${safeName} | ${req.file.size}b`);
  } else {
    console.warn(`[${requestId}] No PDF in request — sending text-only email`);
  }

  // ── 3. Build email HTML ────────────────────────────────────────────────────
  const submittedAt = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
  });

  // Send full resume text — no truncation.
  // PDF attachment is the primary document; text is a readable backup.
  const preview = resumeText || '(No resume text provided)';

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e">
    <div style="background:linear-gradient(135deg,#2D5BE3,#7C3AED);padding:24px;border-radius:12px 12px 0 0">
      <h1 style="color:#fff;margin:0;font-size:20px">📄 New Human Review Request</h1>
      <p style="color:rgba(255,255,255,.8);margin:6px 0 0;font-size:13px">Submitted via Next Hire App</p>
    </div>
    <div style="background:#f8f9ff;padding:24px;border:1px solid #e0e4ff;border-top:none">
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
        <tr><td style="padding:8px 0;color:#666;width:130px">👤 Name</td>
            <td style="padding:8px 0;font-weight:600">${esc(userName)}</td></tr>
        <tr><td style="padding:8px 0;color:#666">📧 Email</td>
            <td style="padding:8px 0">
              <a href="mailto:${esc(userEmail)}" style="color:#2D5BE3">${esc(userEmail)}</a>
            </td></tr>
        <tr><td style="padding:8px 0;color:#666">🎯 Role</td>
            <td style="padding:8px 0;font-weight:600">${esc(targetRole)}</td></tr>
        <tr><td style="padding:8px 0;color:#666">🕐 Time</td>
            <td style="padding:8px 0">${submittedAt} IST</td></tr>
      </table>

      ${notes && notes !== 'None' ? `
      <div style="background:#fff;border-left:4px solid #7C3AED;padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:20px">
        <p style="font-size:12px;color:#666;margin:0 0 4px;text-transform:uppercase;letter-spacing:.5px">Notes</p>
        <p style="margin:0;font-size:14px;line-height:1.5">${esc(notes)}</p>
      </div>` : ''}

      ${attachments.length > 0
        ? `<div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:12px 16px;margin-bottom:20px">
             <p style="margin:0;font-size:14px;color:#2e7d32">📎 <strong>Resume PDF attached above</strong> — check email attachments</p>
           </div>`
        : `<div style="background:#fff3e0;border:1px solid #ffb74d;border-radius:8px;padding:12px 16px;margin-bottom:20px">
             <p style="margin:0;font-size:14px;color:#e65100">⚠️ PDF not received — full resume text is below</p>
           </div>`}

      ${preview ? `
      <div style="background:#fff;border:1px solid #e0e4ff;border-radius:8px;padding:16px;margin-bottom:20px">
        <p style="font-size:12px;color:#666;margin:0 0 8px;text-transform:uppercase;letter-spacing:.5px">Resume preview</p>
        <pre style="font-size:12px;line-height:1.6;white-space:pre-wrap;margin:0;color:#333;font-family:monospace">${esc(preview)}</pre>
      </div>` : ''}

      <div style="background:#e3f2fd;border-radius:8px;padding:14px 16px;text-align:center">
        <p style="margin:0;font-size:13px;color:#1565c0">
          ⏱ Reply to <a href="mailto:${esc(userEmail)}" style="color:#1565c0;font-weight:700">${esc(userEmail)}</a>
          within <strong>24 hours</strong>
        </p>
      </div>
    </div>
    <div style="background:#f0f0f0;padding:12px;border-radius:0 0 12px 12px;text-align:center">
      <p style="margin:0;font-size:11px;color:#888">Next Hire — AI Resume Analyzer</p>
    </div>
  </div>`;

  // ── 4. Send via Resend ─────────────────────────────────────────────────────
  try {
    const resend = getResendClient();
    const from   = process.env.RESEND_FROM || 'onboarding@resend.dev';
    const to     = process.env.ADMIN_EMAIL;

    const { data, error } = await resend.emails.send({
      from,
      to,
      reply_to: userEmail,   // hitting Reply in Gmail goes directly to user
      subject:  `📄 Resume Review — ${userName} (${targetRole})`,
      html,
      attachments,
    });

    if (error) {
      console.error(`[${requestId}] ❌ Resend error:`, error);
      return res.status(500).json({
        success: false,
        error: 'Failed to send notification email. Your request is still recorded.',
      });
    }

    console.log(`[${requestId}] ✅ Email sent via Resend | id=${data?.id}`);
    return res.json({ success: true, message: 'Review request submitted. Admin notified.' });

  } catch (err) {
    console.error(`[${requestId}] ❌ Resend exception:`, err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to send notification email. Your request is still recorded.',
    });
  }
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = { submitHumanReview };
