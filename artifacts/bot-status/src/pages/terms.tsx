import { motion } from "framer-motion";
import { OPERATOR_NAME, EFFECTIVE_DATE, CONTACT_EMAIL, CREATOR_NAME, OWNER_NAME } from "@/lib/constants";

export default function Terms() {
  return (
    <div className="flex flex-col max-w-4xl mx-auto">
        <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex flex-col gap-4 border-b border-border pb-8 mb-8"
      >
        <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-3 py-1 text-xs font-mono border border-primary/20 w-fit">
          LEGAL DOCUMENT
        </div>
        <h1 className="text-4xl font-bold tracking-tight text-foreground">
          Terms of Service
        </h1>
        <div className="text-sm text-muted-foreground font-mono mt-2">
          Effective Date: {EFFECTIVE_DATE}
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        className="prose prose-slate dark:prose-invert max-w-none prose-headings:font-semibold prose-h2:text-2xl prose-h2:mt-12 prose-h2:mb-4 prose-p:text-muted-foreground prose-li:text-muted-foreground"
      >
        <p>
          These Terms of Service ("Terms") govern your access to and use of the Quartermaster Discord Bot and its associated services, interfaces, and APIs (collectively, the "Service"). The Service is owned by {OWNER_NAME}, created and managed by {CREATOR_NAME}, and operated by {OPERATOR_NAME} (collectively, "we," "us," or "our").
        </p>
        <p>
          By inviting the Service to a Discord server, interacting with it, or authorizing it to perform actions on your behalf, you agree to be bound by these Terms. If you do not agree to these Terms, you may not use the Service.
        </p>

        <h2>1. Eligibility and Authority</h2>
        <p>
          To add the Service to a Discord server ("Guild"), you must be an administrator of that Guild and have the requisite permissions to bind the Guild and its members to these Terms. You represent and warrant that you possess such authority. The Service is not intended for use by individuals under the age of 13, or under the age of digital consent in their jurisdiction. 
        </p>

        <h2>2. Acceptable Use</h2>
        <p>
          You agree to use the Service strictly in accordance with these Terms and all applicable laws. You shall not, and shall not permit any third party to:
        </p>
        <ul>
          <li>Use the Service to distribute malicious software, spam, or abusive material.</li>
          <li>Attempt to reverse engineer, decompile, or bypass any security mechanisms of the Service.</li>
          <li>Overwhelm the Service with excessive requests designed to degrade its performance or availability (e.g., denial of service attacks).</li>
          <li>Use the Service to conduct unauthorized surveillance or scrape data from users.</li>
          <li>Utilize the Service in any manner that violates the Discord Terms of Service or Roblox Terms of Use.</li>
        </ul>

        <h2>3. Command Authorization and Moderation</h2>
        <p>
          The Service provides server setup and blacklist moderation tools, including audit records, role enforcement, and integrations with Trello and Roblox. It acts only on commands and configuration provided by authorized users.
        </p>
        <ul>
          <li><strong>Delegation of Authority:</strong> When an authorized user issues a command, they direct the Service to execute actions within the Guild or on integrated platforms. The Guild administrator is solely responsible for determining which users possess the roles required to issue such commands.</li>
          <li><strong>Accuracy:</strong> You are responsible for ensuring the accuracy of data provided to the Service. {OPERATOR_NAME} is not liable for unintended moderation actions or blacklist entries resulting from inaccurate inputs or misconfigured roles.</li>
        </ul>

        <h2>4. Third-Party Platforms and Integrations</h2>
        <p>
          The Service is an independent application and is <strong>not affiliated with, endorsed by, or sponsored by Discord Inc., Roblox Corporation, or Trello (Atlassian).</strong>
        </p>
        <p>
          To provide its blacklist moderation and integration features, the Service may interact with Discord, Roblox, and Trello APIs. Your use of the Service is subject to your compliance with the respective terms and policies of these third-party platforms. We do not control and are not responsible for the availability, uptime, or functionality of these external APIs.
        </p>

        <h2>5. User-Submitted Content</h2>
        <p>
          Through the Service, you may submit usernames, moderation reasons, server configuration, and other information needed for blacklisting and moderation ("User Content"). By submitting User Content, you grant {OPERATOR_NAME} a worldwide, non-exclusive, royalty-free license to process, store, and transmit this content solely for the purpose of operating and maintaining the Service. You retain all ownership rights to your User Content. You are entirely responsible for the legality and appropriateness of all User Content processed through your Guild.
        </p>

        <h2>6. Service Changes and Availability</h2>
        <p>
          We continually strive to improve the Service. We may add, alter, or remove features, and we may suspend or discontinue the Service entirely. We provide no guarantee of continuous uptime or uninterrupted availability. We may occasionally perform maintenance that results in temporary downtime.
        </p>

        <h2>7. Disclaimers of Warranties</h2>
        <p>
          THE SERVICE IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS. TO THE MAXIMUM EXTENT PERMITTED BY LAW, {OPERATOR_NAME.toUpperCase()} DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR ENTIRELY SECURE.
        </p>

        <h2>8. Limitation of Liability</h2>
        <p>
          IN NO EVENT SHALL {OPERATOR_NAME.toUpperCase()} BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS, DATA, USE, OR GOODWILL, ARISING OUT OF OR IN CONNECTION WITH YOUR ACCESS TO OR USE OF (OR INABILITY TO ACCESS OR USE) THE SERVICE, WHETHER BASED ON WARRANTY, CONTRACT, TORT (INCLUDING NEGLIGENCE), OR ANY OTHER LEGAL THEORY, EVEN IF WE HAVE BEEN INFORMED OF THE POSSIBILITY OF SUCH DAMAGE.
        </p>

        <h2>9. Suspension and Termination</h2>
        <p>
          We reserve the right to suspend or terminate your access to the Service, or the Service's presence in any Guild, at our sole discretion, at any time and without notice or liability, for any reason, including but not limited to a breach of these Terms or the generation of excessive API load. You may terminate this agreement at any time by removing the Service from your Guild and ceasing all interaction with it.
        </p>

        <h2>10. Changes to these Terms</h2>
        <p>
          We may modify these Terms periodically. If we make material changes, we will attempt to provide notice via the Service's status page or through announcements in support channels. Your continued use of the Service after the effective date of the revised Terms constitutes your acceptance of the changes.
        </p>

        <h2>11. Contact Information</h2>
        <p>
          If you have any questions or concerns regarding these Terms or the operation of the Service, please contact us at:
        </p>
        <a
          href={`mailto:${CONTACT_EMAIL}`}
          className="font-mono bg-secondary/50 px-3 py-2 rounded-sm border border-border inline-block no-underline hover:border-primary hover:text-primary transition-colors"
          data-testid="link-terms-contact"
        >
          {CONTACT_EMAIL}
        </a>
      </motion.div>
    </div>
  );
}
