const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendMail(options) {
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER;
  const mailOptions = { from, ...options };
  return transporter.sendMail(mailOptions);
}

module.exports = { transporter, sendMail };