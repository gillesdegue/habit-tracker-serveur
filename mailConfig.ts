export const mailConfig = {
  host: process.env.MAIL_HOST || 'smtp.hostinger.com',
  port: parseInt(process.env.MAIL_PORT || '465', 10),
  secure: process.env.MAIL_SECURE !== 'false',
  auth: {
    user: process.env.MAIL_USER || '',
    pass: process.env.MAIL_PASS || '',
  },
  from:
    process.env.MAIL_FROM ||
    '"Habit Tracker" <noreply@digitalelevate.info>',
  appScheme: process.env.MOBILE_APP_SCHEME || 'com.habittracker.app',
};

export function isMailConfigured(): boolean {
  return Boolean(mailConfig.auth.user && mailConfig.auth.pass);
}
