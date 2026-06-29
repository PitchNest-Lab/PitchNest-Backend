import nodemailer from "nodemailer";

export const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,       // smtp.gmail.com
  port: Number(process.env.MAIL_PORT), // 587
  secure: false,
  auth: {
    user: process.env.MAIL_USER,     // pitchnestapp@gmail.com
    pass: process.env.MAIL_PASS,     // Gmail App Password
  },
});