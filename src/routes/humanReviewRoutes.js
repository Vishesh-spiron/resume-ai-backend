// src/routes/humanReviewRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/human-review/submit
//
// Accepts multipart/form-data from Flutter:
//   Fields: userName, userEmail, targetRole, notes, resumeText
//   File:   resume (PDF, max 5MB)
//
// multer stores the file in memory (Buffer) — no temp files written to disk.
// The Buffer goes straight into the Nodemailer attachment.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const multer  = require('multer');

const { submitHumanReview }         = require('../controllers/humanReviewController');
const { generalLimiter }            = require('../middleware/rateLimit');

const router = express.Router();

// ── multer config ─────────────────────────────────────────────────────────────
// memoryStorage keeps the file in req.file.buffer — never hits the filesystem.
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize:  5 * 1024 * 1024,  // 5 MB max — typical resume PDF is < 500 KB
    files:     1,                 // only one file per request
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are accepted for resume upload.'));
    }
  },
});

// ── Route ─────────────────────────────────────────────────────────────────────
// Rate limited to 5 per 15 min — same strictness as verify-payment.
// upload.single('resume') parses the multipart body and populates req.file.
// The field name 'resume' must match what Flutter sends in MultipartFile.
router.post(
  '/submit',
  generalLimiter,
  upload.single('resume'),
  submitHumanReview,
);

// ── multer error handler ──────────────────────────────────────────────────────
// Catches oversized files and wrong file types before they reach the controller.
// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'PDF too large. Maximum size is 5 MB.' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err?.message?.includes('Only PDF')) {
    return res.status(400).json({ error: err.message });
  }
  return res.status(500).json({ error: 'Upload failed.' });
});

module.exports = router;
