import nodemailer from 'nodemailer';
import dotenv from "dotenv";

dotenv.config();

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST ,
  port: process.env.EMAIL_PORT,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

if (process.env.EMAIL_USER && process.env.EMAIL_HOST) {
  transporter.verify(function (error, success) {
    if (error) {
      console.log('Email transporter error (non-critical):', error.message);
    } else {
      console.log('Email server is ready to send messages');
    }
  });
}

export async function sendPasswordResetEmail({ email, name, resetLink }) {
  const mailOptions = {
    from: `"Startup Portal" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "Reset Your Startup Portal Password",
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h2>Password Reset Request</h2>

        <p>Hi ${name || "there"},</p>

        <p>
          We received a request to reset your password for your
          <strong>Startup Portal</strong> account.
        </p>

        <p>
          Click the button below to set a new password:
        </p>

        <p style="margin: 20px 0;">
          <a href="${resetLink}"
             style="
               background-color: #b52020;
               color: white;
               padding: 12px 24px;
               text-decoration: none;
               border-radius: 6px;
               font-weight: bold;
             ">
            Reset Password
          </a>
        </p>

        <p>
          This link will expire in <strong>1 hour</strong>.
        </p>

        <p>
          If you did not request this, you can safely ignore this email.
        </p>

        <br>
        <p>
          Warm regards,<br>
          Startup Portal Support Team
        </p>
      </div>
    `
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("Password reset email sent:", info.messageId);
    return { success: true };
  } catch (error) {
    console.error("Error sending reset email:", error);
    return { success: false, error: error.message };
  }
}

export default { sendPasswordResetEmail  };