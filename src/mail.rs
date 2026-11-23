//! SMTP is optional. Missing configuration disables invitations, never fakes delivery.
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{Mailbox, MultiPart, SinglePart},
    transport::smtp::authentication::Credentials,
};
use std::time::Duration;

#[derive(Clone)]
pub struct MailConfig {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    sender: Mailbox,
    pub(crate) console_origin: String,
}

pub fn normalize_email(value: &str) -> Option<String> {
    let email = value.trim().to_lowercase();
    if email.len() > 254
        || email.contains(['\r', '\n'])
        || email.parse::<lettre::Address>().is_err()
    {
        return None;
    }
    Some(email)
}

impl MailConfig {
    pub fn from_env() -> Result<Option<Self>, &'static str> {
        let get = |name| std::env::var(name).ok();
        let Some(host) = get("ACCLIMATE_SMTP_HOST") else {
            if [
                "ACCLIMATE_SMTP_PORT",
                "ACCLIMATE_SMTP_FROM",
                "ACCLIMATE_SMTP_TLS",
                "ACCLIMATE_SMTP_USERNAME",
                "ACCLIMATE_SMTP_PASSWORD",
            ]
            .iter()
            .any(|key| get(key).is_some())
            {
                return Err("ACCLIMATE_SMTP_HOST is required when configuring email");
            }
            return Ok(None);
        };
        let origin = get("ACCLIMATE_CONSOLE_ORIGIN")
            .ok_or("ACCLIMATE_CONSOLE_ORIGIN is required for invitations")?;
        let url = reqwest::Url::parse(&origin).map_err(|_| "Invalid invitation console origin")?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err("Invitation console origin must be an HTTPS origin");
        }
        let sender = get("ACCLIMATE_SMTP_FROM")
            .ok_or("ACCLIMATE_SMTP_FROM is required")?
            .parse()
            .map_err(|_| "Invalid SMTP sender")?;
        let tls = get("ACCLIMATE_SMTP_TLS").unwrap_or_else(|| "starttls".into());
        let builder = match tls.as_str() {
            "starttls" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)
                .map_err(|_| "Invalid SMTP host")?,
            "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
                .map_err(|_| "Invalid SMTP host")?,
            "none" if matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1" | "mailpit") => {
                AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&host)
            }
            _ => return Err("SMTP TLS must be starttls or tls; none is limited to local Mailpit"),
        };
        let port = get("ACCLIMATE_SMTP_PORT")
            .unwrap_or_else(|| if tls == "tls" { "465" } else { "587" }.into())
            .parse::<u16>()
            .map_err(|_| "Invalid SMTP port")?;
        if port == 0 {
            return Err("Invalid SMTP port");
        }
        let mut builder = builder.port(port).timeout(Some(Duration::from_secs(10)));
        match (
            get("ACCLIMATE_SMTP_USERNAME"),
            get("ACCLIMATE_SMTP_PASSWORD"),
        ) {
            (Some(user), Some(password))
                if !user.is_empty() && !password.is_empty() && tls != "none" =>
            {
                builder = builder.credentials(Credentials::new(user, password))
            }
            (None, None) => {}
            _ => return Err("SMTP credentials must be a complete pair over TLS"),
        }
        Ok(Some(Self {
            transport: builder.build(),
            sender,
            console_origin: origin.trim_end_matches('/').into(),
        }))
    }

    pub(crate) async fn invite(
        &self,
        recipient: &str,
        workspace: &str,
        role: &str,
        id: uuid::Uuid,
    ) -> Result<(), ()> {
        let (text, html) = invitation_body(
            recipient,
            workspace,
            role,
            &format!("{}/invitations/{id}", self.console_origin),
        );
        self.send(
            recipient,
            "You're invited to an Acclimate workspace",
            text,
            html,
        )
        .await
    }

    pub(crate) async fn claim_learning_alert(
        &self,
        db: &sqlx::PgPool,
    ) -> Result<Option<LearningAlert>, sqlx::Error> {
        sqlx::query_as("WITH pending AS (
            SELECT d.round_id,d.user_id,u.email,p.name AS workspace,b.name AS bundle,r.reverted
            FROM learning_alert_deliveries d JOIN learning_rounds r ON r.id=d.round_id
            JOIN bundles b ON b.id=r.bundle_id JOIN projects p ON p.id=r.project_id
            JOIN project_memberships m ON m.user_id=d.user_id AND m.project_id=p.id AND m.role='admin'
            JOIN users u ON u.id=m.user_id AND u.email_verified
            WHERE d.sent_at IS NULL AND d.attempts<5 AND d.next_attempt_at<=now()
            ORDER BY d.next_attempt_at LIMIT 1 FOR UPDATE OF d SKIP LOCKED)
            UPDATE learning_alert_deliveries d SET attempts=attempts+1,next_attempt_at=now()+interval '1 minute'
            FROM pending p WHERE (d.round_id,d.user_id)=(p.round_id,p.user_id)
            RETURNING d.round_id,d.user_id,p.email,p.workspace,p.bundle,d.score,d.previous_score,d.flipped_tasks,p.reverted")
            .fetch_optional(db).await
    }

    pub(crate) async fn deliver_learning_alert(
        &self,
        db: &sqlx::PgPool,
        alert: LearningAlert,
    ) -> Result<(), sqlx::Error> {
        let (text, html) = alert.body();
        if self
            .send(
                &alert.email,
                "Acclimate held-out score decreased",
                text,
                html,
            )
            .await
            .is_ok()
        {
            sqlx::query("UPDATE learning_alert_deliveries SET sent_at=now() WHERE (round_id,user_id)=($1,$2)")
                .bind(alert.round_id).bind(alert.user_id).execute(db).await?;
        }
        Ok(())
    }

    async fn send(
        &self,
        recipient: &str,
        subject: &str,
        text: String,
        html: String,
    ) -> Result<(), ()> {
        let message = Message::builder()
            .from(self.sender.clone())
            .to(recipient.parse().map_err(|_| ())?)
            .subject(subject)
            .multipart(
                MultiPart::alternative()
                    .singlepart(SinglePart::plain(text))
                    .singlepart(SinglePart::html(html)),
            )
            .map_err(|_| ())?;
        tokio::time::timeout(Duration::from_secs(15), self.transport.send(message))
            .await
            .map_err(|_| ())?
            .map_err(|_| ())?;
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
pub(crate) struct LearningAlert {
    round_id: uuid::Uuid,
    user_id: uuid::Uuid,
    email: String,
    workspace: String,
    bundle: String,
    previous_score: f64,
    score: f64,
    flipped_tasks: i32,
    reverted: bool,
}
impl LearningAlert {
    fn body(&self) -> (String, String) {
        let text = format!(
            "The held-out score for {} in {} fell from {:.1}% to {:.1}%. {} tasks changed from pass to fail. {}",
            self.bundle,
            self.workspace,
            100.0 * self.previous_score,
            100.0 * self.score,
            self.flipped_tasks,
            if self.reverted {
                "The service restored the previous version."
            } else {
                "The service did not restore the previous version."
            }
        );
        let html = format!(
            include_str!("email/learning-alert.html"),
            body = escape_html(&text)
        );
        (text, html)
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn invitation_body(recipient: &str, workspace: &str, role: &str, url: &str) -> (String, String) {
    let (role, permission) = match role {
        "admin" => ("Administrator", "Manage content and workspace members."),
        "editor" => ("Editor", "Read and update your team’s content."),
        _ => ("Viewer", "Read your team’s published content."),
    };
    let text = format!(
        "You're invited to join {workspace} with {role} access.\n{permission}\n\nJoin workspace: {url}\n\nSign in or create an account using {recipient}. You must verify that email before joining.\n\nThis invitation expires in seven days. If you weren't expecting it, you can ignore it. You won't join until you accept.\n"
    );
    let html = format!(
        include_str!("email/invitation.html"),
        workspace = escape_html(workspace),
        role = role,
        permission = permission,
        recipient = escape_html(recipient),
        url = escape_html(url)
    );
    (text, html)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn email_is_an_address_not_a_mail_header() {
        assert_eq!(
            normalize_email(" Alice@Example.com ").as_deref(),
            Some("alice@example.com")
        );
        for invalid in [
            "",
            "Alice <a@example.com>",
            "a@example.com\r\nBcc: x@example.com",
            "not-an-email",
        ] {
            assert!(normalize_email(invalid).is_none());
        }
    }

    #[test]
    fn held_out_alert_escapes_bundle_names_and_reports_only_aggregates() {
        let alert = LearningAlert {
            round_id: uuid::Uuid::nil(),
            user_id: uuid::Uuid::nil(),
            email: "admin@example.test".into(),
            workspace: "workspace".into(),
            bundle: "<bundle>".into(),
            previous_score: 0.8,
            score: 0.6,
            flipped_tasks: 3,
            reverted: true,
        };
        let (text, html) = alert.body();
        assert!(text.contains("80.0% to 60.0%. 3 tasks"));
        assert!(html.contains("&lt;bundle&gt;"));
        assert!(!html.contains("<bundle>"));
    }

    #[test]
    fn invitation_escapes_untrusted_content_and_keeps_a_complete_text_fallback() {
        let workspace = "Accounts <script>alert('x')</script> & \"Partners\" {url}";
        let url = "https://console.example/invitations/123?x=1&y=2";
        let (text, html) = invitation_body("a+b@example.test", workspace, "editor", url);
        assert!(!html.contains("<script>"));
        assert!(html.contains(
            "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;Partners&quot; {url}"
        ));
        assert!(html.contains("href=\"https://console.example/invitations/123?x=1&amp;y=2\""));
        assert!(html.contains("Editor access"));
        assert!(
            text.contains(workspace) && text.contains(url) && text.contains("a+b@example.test")
        );
        assert!(text.contains("seven days") && text.contains("verify that email"));
    }
}
