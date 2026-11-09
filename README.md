# 🐱 Pocket Agent

<p align="center">
  <img src="https://raw.githubusercontent.com/KenKaiii/pocket-agent/main/assets/icon_rounded_1024.png" alt="Pocket Agent" width="200">
</p>

<p align="center">
  <strong>Your AI that actually knows you.</strong>
</p>

<p align="center">
  <a href="https://github.com/KenKaiii/pocket-agent/releases/latest"><img src="https://img.shields.io/github/v/release/KenKaiii/pocket-agent?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://www.skool.com/raid"><img src="https://img.shields.io/badge/Skool-Free%20community-7C3AED?style=for-the-badge" alt="Free Skool community"></a>
</p>

**Pocket Agent** is a personal AI that lives in your menu bar 24/7. It remembers everything, learns who you are, and actually gets better at helping you over time.

It's not just a chatbot. It extracts facts about you, runs automations while you sleep, manages your calendar and tasks, and evolves to work with *you specifically*. Talk to it from your desktop or Telegram. Set up routines that do stuff on your behalf. It's an assistant that's always there.

> [!TIP]
> **Want to build your own apps with AI?** A free 7-day build challenge and 20+ step-by-step projects are in my free community: **[skool.com/raid](https://www.skool.com/raid)**

---

## 🧠 Why this exists

Every AI assistant starts from zero. Every. Single. Time.

Pocket Agent keeps everything. Not just chat logs, but facts about your life, your projects, your preferences. It uses semantic search to pull up stuff from months ago. And it has a "soul" system that learns *how* to work with you better over time.

The more you use it, the more useful it becomes.

---

## ✨ What it actually does

### Persistent memory that actually works
Not just storing messages. It actively extracts and organizes knowledge about you. Projects you're working on. People you mention. Decisions you've made. Preferences you've expressed. All searchable. When you mention something from three months ago, it knows what you're talking about.

### Routines and automations
Create scheduled prompts that run automatically and take action:
- "Every morning at 8am, check my calendar and Slack, then give me a briefing"
- "Every Friday at 5pm, review what I accomplished this week and update my progress doc"
- "Monitor this webpage daily and alert me if the price drops"

These aren't just reminders. They're full agent executions with access to tools, browser automation, and your conversation history.

### Self-improving over time
The "soul" system learns how to work with *you specifically*. Not facts about you, but facts about the dynamic. Your communication style. What kind of responses you prefer. Boundaries you've set. It gets better the more you use it.

### Browser automation with authenticated sessions
Two modes:
- **Basic mode:** Hidden window for screenshots, clicking, form filling, data extraction
- **Chrome mode:** Connects to your actual browser with all your logged-in sessions (Gmail, GitHub, whatever). No re-authentication needed.

Automate workflows that require being logged in. Scrape data from sites you have access to. Fill out forms across multiple sites.

### Multi-session isolation
Up to 5 separate conversation threads, each with completely isolated memory. Work stuff doesn't bleed into personal stuff. Each session has its own facts, tasks, calendar, and conversation history.

### Telegram integration
Same brain, different interface. Talk to it from your phone with full access to memory and tools. Add the bot to group chats and link each group to a different session. Your work group stays separate from your personal one.

### Calendar, tasks, and reminders
Built-in task management with priorities, due dates, and automatic reminders. Calendar events with location and time-based alerts. Daily logs for journaling. The agent can create, modify, and remind you about any of it.

### 40+ skill integrations
Notion, GitHub, Slack, Apple Notes, Apple Reminders, Google Workspace, Trello, Obsidian, and more. Plus MCP server support for adding your own. Full terminal access when you need it.

### Customizable personality
Edit the identity file to change how it talks. Make it formal, casual, terse, verbose. Whatever works for you.

---

## 🚀 Getting started

### Download

| Mac | Link |
|-----|------|
| Apple Silicon (M1/M2/M3/M4) | [Download](https://github.com/KenKaiii/pocket-agent/releases/latest) |
| Intel | [Download](https://github.com/KenKaiii/pocket-agent/releases/latest) |

### Setup

1. Drag to Applications, launch it
2. It shows up in your menu bar
3. Click it, paste your Anthropic API key (get one at [console.anthropic.com](https://console.anthropic.com))
4. Start chatting

That's it.

---

## 📱 Telegram setup (optional)

If you want to talk to it from your phone:

1. Create a bot with [@BotFather](https://t.me/botfather) on Telegram
2. Copy the token into Pocket Agent settings
3. Message your bot

**Group chats:** You can add the bot to groups. Use `/link SessionName` to connect that group to a specific session. Each group can have its own isolated conversation.

**Note:** For the bot to see all messages in a group (not just commands), either make it an admin or disable privacy mode in BotFather.

**Commands:** `/status` `/facts` `/clear` `/link <session>` `/unlink` `/mychatid`

---

## 🌐 Browser automation details

**Default mode** runs in a hidden Electron window. No setup needed. Works for:
- Screenshots
- Clicking elements (by CSS selector)
- Typing into inputs
- Extracting page content (text, HTML, links, tables)
- Running JavaScript
- Downloading files

**Chrome mode** connects to your actual browser. You need to start Chrome with remote debugging:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

Then it can access your logged-in sessions and manage multiple tabs.

---

## 🔒 Privacy

- Everything stored locally in SQLite on your machine
- Conversations go to Anthropic's API (that's how it works)
- API keys stored in your system keychain
- No analytics, no telemetry

---

## 🔌 Extensibility

There's a skill system with 40+ integrations (Notion, GitHub, Slack, Apple Notes, etc.) and support for MCP servers if you want to extend it. Plus full terminal access.

Most people won't need this stuff, but it's there if you do.

---

## 🛠️ For developers

```bash
git clone https://github.com/KenKaiii/pocket-agent.git
cd pocket-agent
npm install
npm run dev
```

Stack: Electron + Claude Agent SDK + SQLite + TypeScript

---

## 👥 Community

- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai) - tutorials and demos
- [Free Skool community](https://www.skool.com/raid): a 7-day build challenge and 20+ step-by-step projects

---

## 📄 License

MIT

---

<p align="center">
  <strong>An AI that remembers you, learns from you, and works for you. Even when you're not there.</strong>
</p>

<p align="center">
  <a href="https://github.com/KenKaiii/pocket-agent/releases/latest"><img src="https://img.shields.io/badge/Download-Latest%20Release-blue?style=for-the-badge" alt="Download"></a>
</p>
