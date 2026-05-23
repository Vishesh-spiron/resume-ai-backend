// src/controllers/humanReviewController.js
// ─────────────────────────────────────────────────────────────────────────────
// Receives a multipart POST from Flutter containing:
//   - userName, userEmail, targetRole, notes, resumeText  (form fields)
//   - resume (PDF file, optional but strongly recommended)
//
// Sends an email to the admin via Nodemailer with the PDF attached.
// No Firebase Storage — the PDF travels directly: Flutter → backend → Gmail.
// ─────────────────────────────────────────────────────────────────────────────

const { transporter } = require('../config/emailer');

async function submitHumanReview(req, res) {
  const { requestId } = req;

  // ── 1. Extract form fields ─────────────────────────────────────────────────
  const {
    userName    = 'Unknown',
    userEmail   = '',
    targetRole  = 'Not specified',
    notes       = 'None',
    resumeText  = '',
  } = req.body ?? {};

  if (!userEmail) {
    return res.status(400).json({ error: 'Missing required field: userEmail' });
  }

  // ── 2. Build PDF attachment (if file was sent) ─────────────────────────────
  // multer stores the uploaded file in memory as req.file.buffer
  const attachments = [];

  if (req.file) {
    const safeName = (req.file.originalname || 'resume.pdf')
      .replace(/[^a-zA-Z0-9._-]/g, '_');

    attachments.push({
      filename:    safeName,
      content:     req.file.buffer,    // raw PDF bytes — no disk writes
      contentType: 'application/pdf',
    });

    console.log(
      `[${requestId}] PDF attached | name=${safeName} size=${req.file.size}b`,
    );
  } else {
    console.warn(`[${requestId}] No PDF file in request — sending text-only email`);
  }

  // ── 3. Build email HTML ────────────────────────────────────────────────────
  const submittedAt = new Date().toLocaleString('en-IN', {
    timeZone:     'Asia/Kolkata',
    dateStyle:    'medium',
    timeStyle:    'short',
  });

  // Truncate resume text preview to keep email readable
  const preview = resumeText.length > 2500
    ? resumeText.substring(0, 2500) + '\n\n[...truncated. Full resume is attached as PDF above.]'
    : resumeText;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e">
      <div style="background:linear-gradient(135deg,#2D5BE3,#7C3AED);padding:24px;border-radius:12px 12px 0 0">
        <h1 style="color:#fff;margin:0;font-size:20px">📄 New Human Review Request</h1>
        <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:13px">Submitted via Next Hire App</p>
      </div>

      <div style="background:#f8f9ff;padding:24px;border:1px solid #e0e4ff;border-top:none">

        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
          <tr><td style="padding:8px 0;color:#666;width:130px">👤 Name</td>
              <td style="padding:8px 0;font-weight:600">${escHtml(userName)}</td></tr>
          <tr><td style="padding:8px 0;color:#666">📧 Email</td>
              <td style="padding:8px 0">
                <a href="mailto:${escHtml(userEmail)}" style="color:#2D5BE3">${escHtml(userEmail)}</a>
              </td></tr>
          <tr><td style="padding:8px 0;color:#666">🎯 Target role</td>
              <td style="padding:8px 0;font-weight:600">${escHtml(targetRole)}</td></tr>
          <tr><td style="padding:8px 0;color:#666">🕐 Submitted</td>
              <td style="padding:8px 0">${submittedAt} IST</td></tr>
        </table>

        ${notes && notes !== 'None' ? `
        <div style="background:#fff;border-left:4px solid #7C3AED;padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:20px">
          <p style="font-size:12px;color:#666;margin:0 0 4px;text-transform:uppercase;letter-spacing:.5px">Notes from candidate</p>
          <p style="margin:0;font-size:14px;line-height:1.5">${escHtml(notes)}</p>
        </div>` : ''}

        ${attachments.length > 0 ? `
        <div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:12px 16px;margin-bottom:20px">
          <p style="margin:0;font-size:14px;color:#2e7d32">
            📎 <strong>Resume PDF attached</strong> — see attachment above
          </p>
        </div>` : `
        <div style="background:#fff3e0;border:1px solid #ffb74d;border-radius:8px;padding:12px 16px;margin-bottom:20px">
          <p style="margin:0;font-size:14px;color:#e65100">
            ⚠️ No PDF attached — resume text below
          </p>
        </div>`}

        ${preview ? `
        <div style="background:#fff;border:1px solid #e0e4ff;border-radius:8px;padding:16px;margin-bottom:20px">
          <p style="font-size:12px;color:#666;margin:0 0 8px;text-transform:uppercase;letter-spacing:.5px">Resume text preview</p>
          <pre style="font-size:12px;line-height:1.6;white-space:pre-wrap;margin:0;color:#333;font-family:monospace">${escHtml(preview)}</pre>
        </div>` : ''}

        <div style="background:#e3f2fd;border-radius:8px;padding:14px 16px;text-align:center">
          <p style="margin:0;font-size:13px;color:#1565c0">
            ⏱ Please reply to
            <a href="mailto:${escHtml(userEmail)}" style="color:#1565c0;font-weight:700">${escHtml(userEmail)}</a>
            with the improved resume within <strong>24 hours</strong>
          </p>
        </div>
      </div>

      <div style="background:#f0f0f0;padding:12px;border-radius:0 0 12px 12px;text-align:center">
        <p style="margin:0;font-size:11px;color:#888">Next Hire — AI Resume Analyzer</p>
      </div>
    </div>
  `;

  // ── 4. Send email ──────────────────────────────────────────────────────────
  try {
    const info = await transporter.sendMail({
      from:        `"Next Hire" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to:          process.env.ADMIN_EMAIL,
      replyTo:     userEmail,      // reply goes directly to the user
      subject:     `📄 Resume Review Request — ${userName} (${targetRole})`,
      html,
      attachments,
    });

    console.log(`[${requestId}] ✅ Human review email sent | msgId=${info.messageId}`);

    return res.json({
      success: true,
      message: 'Review request submitted. Admin has been notified.',
    });

  } catch (err) {
    console.error(`[${requestId}] ❌ Email send failed: ${err.message}`);
    return res.status(500).json({
      success: false,
      error:   'Failed to send notification email. Your request is still recorded.',
    });
  }
}

// Simple HTML entity escaping — prevents XSS in email content
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { submitHumanReview };
