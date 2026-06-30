import nodemailer from "nodemailer";
import SMTPTransport from "nodemailer/lib/smtp-transport";

export const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,       // smtp.gmail.com
  port: Number(process.env.MAIL_PORT), // 587
  secure: false,
  family: 4,
  auth: {
    user: process.env.MAIL_USER,     // hello@pitchnest.io
    pass: process.env.MAIL_PASS,     // Gmail App Password
  },
} as SMTPTransport.Options);
