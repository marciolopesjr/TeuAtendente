import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';

@customElement('landing-app')
export class LandingApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 100%;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 20px;
    }

    header {
      padding: 20px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .logo {
      font-size: 1.5rem;
      font-weight: bold;
      color: #ff4500; /* Lobster red */
      text-decoration: none;
    }

    nav a {
      color: #ccc;
      text-decoration: none;
      margin-left: 20px;
      font-weight: 500;
    }

    nav a:hover {
      color: white;
    }

    .hero {
      text-align: center;
      padding: 100px 0;
    }

    h1 {
      font-size: 3.5rem;
      margin-bottom: 20px;
      background: linear-gradient(90deg, #ff4500, #ff8c00);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .subtitle {
      font-size: 1.5rem;
      color: #aaa;
      margin-bottom: 40px;
      max-width: 800px;
      margin-left: auto;
      margin-right: auto;
    }

    .cta-button {
      display: inline-block;
      background: #ff4500;
      color: white;
      padding: 15px 30px;
      border-radius: 30px;
      text-decoration: none;
      font-weight: bold;
      font-size: 1.1rem;
      transition: background 0.2s;
    }

    .cta-button:hover {
      background: #e03e00;
    }

    .features {
      padding: 80px 0;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 40px;
    }

    .feature-card {
      background: #1a1d23;
      padding: 30px;
      border-radius: 12px;
      border: 1px solid #333;
    }

    .feature-title {
      font-size: 1.25rem;
      font-weight: bold;
      margin-bottom: 10px;
      color: #fff;
    }

    .feature-desc {
      color: #aaa;
      line-height: 1.6;
    }

    .pricing {
      padding: 80px 0;
      text-align: center;
    }

    .pricing h2 {
      font-size: 2.5rem;
      margin-bottom: 60px;
    }

    .pricing-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 30px;
    }

    .price-card {
      background: #1a1d23;
      padding: 40px;
      border-radius: 16px;
      border: 1px solid #333;
      display: flex;
      flex-direction: column;
    }

    .price-card.featured {
      border-color: #ff4500;
      position: relative;
    }

    .price-card.featured::after {
      content: 'POPULAR';
      position: absolute;
      top: -12px;
      left: 50%;
      transform: translateX(-50%);
      background: #ff4500;
      color: white;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.8rem;
      font-weight: bold;
    }

    .plan-name {
      font-size: 1.5rem;
      font-weight: bold;
      margin-bottom: 10px;
    }

    .price {
      font-size: 3rem;
      font-weight: bold;
      margin-bottom: 20px;
    }

    .price span {
      font-size: 1rem;
      color: #aaa;
    }

    .features-list {
      list-style: none;
      padding: 0;
      margin: 0 0 30px 0;
      text-align: left;
      flex-grow: 1;
    }

    .features-list li {
      margin-bottom: 15px;
      color: #ccc;
      display: flex;
      align-items: center;
    }

    .features-list li::before {
      content: '✓';
      color: #ff4500;
      margin-right: 10px;
      font-weight: bold;
    }

    footer {
      padding: 40px 0;
      text-align: center;
      color: #666;
      border-top: 1px solid #222;
      margin-top: 60px;
    }
  `;

  render() {
    return html`
      <div class="container">
        <header>
          <a href="#" class="logo">🦞 OpenClaw</a>
          <nav>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a href="https://docs.openclaw.ai">Docs</a>
            <a href="https://github.com/openclaw/openclaw">GitHub</a>
          </nav>
        </header>

        <section class="hero">
          <h1>Your Personal AI Assistant</h1>
          <p class="subtitle">
            Secure, local-first, and always on. Connects to WhatsApp, Telegram, Discord, Slack, and more.
            Now available for Enterprise.
          </p>
          <a href="https://docs.openclaw.ai/start/getting-started" class="cta-button">Get Started</a>
        </section>

        <section id="features" class="features">
          <div class="feature-card">
            <div class="feature-title">Local-First</div>
            <div class="feature-desc">
              Your data stays with you. The control plane runs on your device, ensuring privacy and speed.
            </div>
          </div>
          <div class="feature-card">
            <div class="feature-title">Multi-Channel</div>
            <div class="feature-desc">
              Seamlessly integrates with WhatsApp, Telegram, Signal, Discord, Slack, and more in a unified inbox.
            </div>
          </div>
          <div class="feature-card">
            <div class="feature-title">Agentic Capabilities</div>
            <div class="feature-desc">
              From browser control to visual understanding, OpenClaw can take action on your behalf.
            </div>
          </div>
        </section>

        <section id="pricing" class="pricing">
          <h2>Plans & Pricing</h2>
          <div class="pricing-grid">
            <div class="price-card">
              <div class="plan-name">Community</div>
              <div class="price">$0<span>/mo</span></div>
              <ul class="features-list">
                <li>Open Source (MIT)</li>
                <li>Self-hosted</li>
                <li>Unlimited Channels</li>
                <li>Community Support</li>
              </ul>
              <a href="#" class="cta-button" style="background: #333;">Download</a>
            </div>

            <div class="price-card featured">
              <div class="plan-name">Pro</div>
              <div class="price">$10<span>/mo</span></div>
              <ul class="features-list">
                <li>Everything in Community</li>
                <li>Cloud Gateway Option</li>
                <li>Priority Support</li>
                <li>Advanced Skills Library</li>
              </ul>
              <a href="#" class="cta-button">Subscribe</a>
            </div>

            <div class="price-card">
              <div class="plan-name">Enterprise</div>
              <div class="price">Custom</div>
              <ul class="features-list">
                <li>SSO & Audit Logs</li>
                <li>SLA Guarantees</li>
                <li>Custom Integrations</li>
                <li>Dedicated Account Manager</li>
              </ul>
              <a href="#" class="cta-button" style="background: #333;">Contact Sales</a>
            </div>
          </div>
        </section>

        <footer>
          <p>© 2024 OpenClaw. All rights reserved.</p>
        </footer>
      </div>
    `;
  }
}
