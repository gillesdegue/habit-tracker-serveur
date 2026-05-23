import nodemailer from 'nodemailer';

import { isMailConfigured, mailConfig } from './mailConfig.js';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!isMailConfigured()) {
    throw new Error('Configuration email incomplete.');
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: mailConfig.host,
      port: mailConfig.port,
      secure: mailConfig.secure,
      auth: {
        user: mailConfig.auth.user,
        pass: mailConfig.auth.pass,
      },
    });
  }

  return transporter;
}

export async function sendPasswordResetEmail(
  email: string,
  resetToken: string,
  firstName?: string | null
): Promise<void> {
  const greeting = firstName?.trim() ? `Bonjour ${firstName.trim()}` : 'Bonjour';
  const resetLink = `${mailConfig.appScheme}://reset-password?token=${encodeURIComponent(resetToken)}`;

  const mailOptions = {
    from: mailConfig.from,
    to: email,
    subject: 'Reinitialisation de votre mot de passe Habit Tracker',
    text: `${greeting},\n\nVous avez demande la reinitialisation de votre mot de passe.\n\nOuvrez ce lien sur votre telephone pour choisir un nouveau mot de passe :\n${resetLink}\n\nCe lien expire dans 1 heure.\n\nSi vous n'etes pas a l'origine de cette demande, ignorez cet email.\n\nL'equipe Habit Tracker`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
        <h2 style="color: #F7B500;">Reinitialisation de mot de passe</h2>
        <p>${greeting},</p>
        <p>Vous avez demande la reinitialisation de votre mot de passe pour <strong>Habit Tracker</strong>.</p>
        <p>Appuyez sur le bouton ci-dessous depuis votre telephone pour ouvrir l'application et choisir un nouveau mot de passe :</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetLink}" style="background-color: #F7B500; color: #1e293b; padding: 14px 28px; text-decoration: none; border-radius: 999px; font-weight: bold; display: inline-block;">
            Reinitialiser mon mot de passe
          </a>
        </div>
        <p style="font-size: 13px; color: #64748b;">Ce lien expire dans <strong>1 heure</strong>.</p>
        <p style="font-size: 13px; color: #64748b;">Si le bouton ne fonctionne pas (selon votre client mail), copiez ce lien dans votre navigateur mobile :</p>
        <p style="font-size: 12px; color: #94a3b8; word-break: break-all;"><a href="${resetLink}" style="color: #94a3b8;">${resetLink}</a></p>
        <p style="font-size: 12px; color: #94a3b8; margin-top: 40px; border-top: 1px solid #f1f5f9; padding-top: 20px;">
          Si vous n'etes pas a l'origine de cette demande, ignorez cet email.<br>
          L'equipe Habit Tracker
        </p>
      </div>
    `,
  };

  await getTransporter().sendMail(mailOptions);
}
