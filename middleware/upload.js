import multer from "multer";
import path from "path";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "public/uploads/");
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const pitchDeckFilter = (req, file, cb) => {
  const allowedMimes = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ];
  const allowedExts = [".pdf", ".doc", ".docx", ".ppt", ".pptx"];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimes.includes(file.mimetype) && allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Only PDF, DOC, DOCX, PPT, PPTX files are allowed for pitch decks"), false);
  }
};

const proposalFilter = (req, file, cb) => {
  const allowedMimes = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "image/jpeg",
    "image/png",
    "image/webp"
  ];
  const allowedExts = [".pdf", ".doc", ".docx", ".ppt", ".pptx", ".jpg", ".jpeg", ".png", ".webp"];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimes.includes(file.mimetype) && allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Allowed formats: PDF, DOC, DOCX, PPT, PPTX, JPG, PNG, WEBP"), false);
  }
};

// Resource-issue photos: tighter than proposalFilter (images + PDF only — no
// office docs, since these are damage/malfunction photos, not documents).
const issueAttachmentFilter = (req, file, cb) => {
  const allowedMimes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
  const allowedExts = [".jpg", ".jpeg", ".png", ".webp", ".pdf"];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimes.includes(file.mimetype) && allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Allowed formats: JPG, PNG, WEBP, PDF"), false);
  }
};

export const upload = multer({
  storage,
  fileFilter: pitchDeckFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

export const uploadProposal = multer({
  storage,
  fileFilter: proposalFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

export const uploadIssueAttachment = multer({
  storage,
  fileFilter: issueAttachmentFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB — a phone photo, not a proposal deck
});
