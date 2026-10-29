# Installing Velocity on Linux

This guide shows you how to set up Velocity on a Linux computer or server. The installer does almost all of the work. It takes about five minutes.

On Windows, follow the steps under "By hand" in the [README](README.md) instead.

## What you need

- A Linux system that uses systemd. The installer was tested on Ubuntu 24.04, Fedora 44 and Arch Linux. Other systems that use apt, dnf, pacman or zypper (such as Debian, Linux Mint and openSUSE) should work too.
- An account that can use `sudo`, or the root account.
- An internet connection while the installer runs.
- At least 1 GB of free disk space, plus room for your files.

You do not need to install Node.js. The installer brings its own copy.

## Install Velocity

### 1. Open a terminal

On a desktop, open the Terminal app. On a server, connect with SSH.

### 2. Run the installer

Copy this line into the terminal and press Enter:

```sh
curl -fsSL https://raw.githubusercontent.com/skw359/Velocity/main/install.sh | sudo bash
```

If it says `curl: command not found`, install curl first and run the line again:

| System | Command |
| --- | --- |
| Ubuntu, Debian, Mint | `sudo apt install curl` |
| Fedora | `sudo dnf install curl` |
| Arch | `sudo pacman -S curl` |
| openSUSE | `sudo zypper install curl` |

If you are logged in as root, leave out the word `sudo`.

If you already downloaded Velocity (for example with `git clone`), you can run `sudo bash install.sh` inside that folder instead.

### 3. Answer the questions

Press Enter to accept the answer shown in brackets. Some questions only appear when they apply to your system.

**Port for the web interface [3000]**
The number at the end of Velocity's address. Keep 3000 unless another program already uses it.

**Install the optional preview tools (ffmpeg, ImageMagick, ExifTool)?**
These add previews for .mov videos and .cr3 camera photos. They take a few hundred MB. Velocity works fine without them.

**Allow port 3000 through the firewall so other devices can connect?**
This only appears if a firewall is turned on. Answer yes if you want to use Velocity from your phone or another computer.

**Create the owner account now?**
The owner is the main account. It can reset passwords, turn accounts off or delete them, and choose who can use external drives. Pick a username and a password:

- The username can use 3 to 32 letters, numbers, dots, dashes or underscores.
- The password needs at least 8 characters. It is not shown while you type.

**Ready to install. Continue?**
Press Enter to start.

### 4. Wait for it to finish

The installer now works on its own. You will see each step get a check mark. When it is done, it shows something like this:

```
Velocity is ready
  Open http://192.168.1.50:3000 in a browser on any device on your network,
  or http://localhost:3000 on this computer.
```

### 5. Open Velocity

Open the address in a web browser and sign in with your owner account.

If you skipped the owner account, you will see a sign up page instead. The first account created there becomes the owner. Do this right away, because until the owner exists, anyone who can reach the address could create it.

To give other people accounts, open **Settings → People → Manage** and add them there. Sign-up is closed once the owner exists. If you want people to create their own accounts instead, see [Change settings](#change-settings).

## Everyday use

Velocity runs in the background and starts by itself when the computer turns on. These commands help you look after it:

| To do this | Run this |
| --- | --- |
| Check that it is running | `sudo systemctl status velocity` |
| Restart it | `sudo systemctl restart velocity` |
| Stop it | `sudo systemctl stop velocity` |
| Start it again | `sudo systemctl start velocity` |
| Watch its log | `sudo journalctl -u velocity -f` (press Ctrl+C to stop watching) |

## Where things are kept

| What | Where |
| --- | --- |
| Your accounts and files | `/opt/velocity/app` |
| Settings | `/etc/velocity/velocity.env` |
| The installer's log | `/var/log/velocity-install.log` |

## Back up your files

Everything that matters is in `/opt/velocity/app`. To make a backup:

```sh
sudo systemctl stop velocity
sudo tar -czf velocity-backup.tar.gz -C /opt/velocity app
sudo systemctl start velocity
```

This creates `velocity-backup.tar.gz` in the folder you are in. Copy it to another disk or computer to keep it safe.

## Update Velocity

Run the installer again:

```sh
sudo bash /opt/velocity/install.sh
```

It downloads the newest version and keeps your accounts, files and settings. It takes a minute or two, and Velocity is offline for only a few seconds. People who were signed in stay signed in.

## Change settings

### Change the port

```sh
sudo bash /opt/velocity/install.sh --port 8080
```

This moves Velocity to the new port. If a firewall is turned on, it offers to open the new port too. It also updates Velocity to the newest version.

### Add external drives

Disks mounted under `/media`, `/run/media` or `/mnt` show up in Velocity as external drives, as long as Velocity is allowed to read them. To add a disk mounted somewhere else:

1. Open the settings file in a text editor, for example: `sudo nano /etc/velocity/velocity.env`
2. Find the line that starts with `#VELOCITY_EXTERNAL_DRIVES`. Remove the `#` and replace the example with the place where your disk is mounted, for example: `VELOCITY_EXTERNAL_DRIVES=/data`
3. Save the file, then run `sudo systemctl restart velocity`

If a drive does not show up, Velocity may not be allowed to read it. [DEPLOY-UBUNTU.md](DEPLOY-UBUNTU.md) explains how to mount a disk so Velocity can use it.

### Let people sign themselves up

By default only the owner can add accounts. To let anyone who can reach Velocity create an account:

1. Open the settings file: `sudo nano /etc/velocity/velocity.env`
2. Add the line `VELOCITY_SIGNUP=open` (or remove the `#` in front of it, if it is there).
3. Save the file, then run `sudo systemctl restart velocity`

Only do this if you trust everyone who can reach the address.

## Use Velocity away from home

Velocity uses plain HTTP, which is not encrypted. Do not open it to the whole internet as it is. Two simple options:

- **Tailscale** (easiest): install [Tailscale](https://tailscale.com) on the Velocity computer and on your devices. Then open `http://<Tailscale address of that computer>:3000`.
- **Caddy** (if you have a domain name): install [Caddy](https://caddyserver.com), point your domain at your server, make sure ports 80 and 443 are open, and put this in `/etc/caddy/Caddyfile`:

  ```
  files.example.com {
      reverse_proxy localhost:3000
  }
  ```

  Restart Caddy with `sudo systemctl restart caddy`. Caddy gets an HTTPS certificate for you.

  Then keep the plain-HTTP port private: add `VELOCITY_HOST=127.0.0.1` to `/etc/velocity/velocity.env` and run `sudo systemctl restart velocity`. Only Caddy can reach Velocity after that, and Velocity marks its login cookie Secure because Caddy tells it the visit used HTTPS.

## Install without questions

Add `--yes` to use the default answers. This is handy for scripts:

```sh
curl -fsSL https://raw.githubusercontent.com/skw359/Velocity/main/install.sh | sudo bash -s -- --yes
```

With `--yes`, the installer does not create the owner account, so create it in the browser right after. It also opens the port if a firewall is turned on.

Other options you can add the same way:

| Option | What it does |
| --- | --- |
| `--port 8080` | Use port 8080 instead of 3000 |
| `--no-extras` | Skip the preview tools |
| `--dir /srv/velocity` | Install somewhere other than `/opt/velocity` |
| `--name velocity2` | Run a second, separate copy of Velocity |
| `--help` | Show all options |

## Uninstall

```sh
sudo bash /opt/velocity/install.sh --uninstall
```

This stops Velocity and removes it. After you confirm, it asks about your accounts and files. Type `delete` to erase them, or press Enter to keep them. If you keep them, installing again later picks them back up.

To remove everything without being asked, add `--purge`:

```sh
sudo bash /opt/velocity/install.sh --uninstall --purge
```

The tools the installer added (build tools and preview tools) stay on your system, because other programs may use them.

## Troubleshooting

**"Port 3000 is already in use by another program"**
Another program uses that port. Run the installer again and pick a different port, such as 8080.

**Velocity opens on this computer but not on my phone or other computers**
- Make sure both devices are on the same network.
- Use the address the installer showed, not `localhost`.
- If a firewall is on, run the installer again and answer yes to the firewall question.
- On a cloud server, also open the port in your provider's firewall settings.

**The installer stopped with an error**
It shows what went wrong and where the full log is. Fix the problem (often a network issue) and run the installer again. Running it again is always safe. It continues where it stopped.

**Velocity is not running**
Run `sudo journalctl -u velocity -n 50` to see its last 50 log lines. They usually say what is wrong.

**.mov videos do not play on Fedora**
Fedora's standard ffmpeg cannot convert them. Turn on [RPM Fusion](https://rpmfusion.org/Configuration), then run:

```sh
sudo dnf swap ffmpeg-free ffmpeg --allowerasing
sudo systemctl restart velocity
```

**"This system already has a service called velocity"**
Another program already uses the name velocity. Install Velocity under a different name, for example `--name velocity-files`. If you set Velocity up by hand earlier, stop and remove that service first.

**"The installer needs systemd"**
Your system does not use systemd, so the installer cannot set Velocity up as a service. Follow the steps under "By hand" in the [README](README.md) instead.

## Getting help

When you ask for help, include the installer's log. You can find it at `/var/log/velocity-install.log`.
