import { Hono } from 'hono';
import satori from '@cf-wasm/satori/workerd';
import { Resvg } from '@cf-wasm/resvg/workerd';

import type { Env, Variables } from '../env.js';
import { getSession, getShareLink, getSessionGitState, getInviteByCodeAny, getOrgSettings } from '../lib/db.js';

// DM Sans font — loaded lazily and cached in module scope
let fontData: ArrayBuffer | null = null;

async function getFont(): Promise<ArrayBuffer> {
  if (fontData) return fontData;
  // Fetch DM Sans 600 weight from Google Fonts
  const css = await fetch(
    'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap',
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  ).then((r) => r.text());

  // Extract the first font URL (woff2, woff, or ttf)
  const urlMatch = css.match(/src:\s*url\(([^)]+\.(?:woff2|woff|ttf))\)/);
  if (!urlMatch) throw new Error('Could not find font URL');

  const data = await fetch(urlMatch[1]).then((r) => r.arrayBuffer());
  fontData = data;
  return data;
}

export const ogRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

const GENERIC_SESSION_TITLE = 'Valet session';

interface SessionCard {
  title: string;
  description: string;
  repo: string;
  workspace: string;
}

/**
 * Resolves an active share link to the session details shown in link
 * previews. Previews by bare session ID never reach this: the ID is not an
 * access grant, so those get the generic card.
 */
async function sessionCardForShareToken(db: Variables['db'], token: string): Promise<SessionCard | null> {
  const link = await getShareLink(db, token);
  if (!link) return null;
  const session = await getSession(db, link.sessionId);
  if (!session) return null;
  const gitState = await getSessionGitState(db, link.sessionId);

  const sessionName = session.title || session.workspace || 'Untitled Session';
  const repo = gitState?.sourceRepoFullName || '';
  const workspace = session.workspace || '';
  const parts = [repo, workspace].filter(Boolean);
  return {
    title: `Join session: ${sessionName}`,
    description: parts.length > 0 ? parts.join(' · ') : GENERIC_SESSION_TITLE,
    repo,
    workspace,
  };
}

/**
 * GET /og/meta/session/:id
 * Generic OG metadata for a session URL (public, no auth). Reveals nothing
 * about the session, not even whether it exists.
 */
ogRouter.get('/meta/session/:id', (c) => {
  const { id } = c.req.param();
  const url = new URL(c.req.url);
  return c.json({
    title: GENERIC_SESSION_TITLE,
    description: GENERIC_SESSION_TITLE,
    imageUrl: `${url.origin}/og/image/session/${encodeURIComponent(id)}`,
  });
});

/**
 * GET /og/meta/session-token/:token
 * OG metadata for a share link: the holder of an active link may see the
 * session title, repo and workspace.
 */
ogRouter.get('/meta/session-token/:token', async (c) => {
  const { token } = c.req.param();
  const card = await sessionCardForShareToken(c.get('db'), token);
  if (!card) {
    return c.json({ error: 'Invalid share link' }, 404);
  }
  const url = new URL(c.req.url);
  return c.json({
    title: card.title,
    description: card.description,
    imageUrl: `${url.origin}/og/image/session-token/${encodeURIComponent(token)}`,
  });
});

/**
 * GET /og/image/session/:id
 * Generic OG image for a session URL.
 */
ogRouter.get('/image/session/:id', () => renderSessionCardImage(GENERIC_SESSION_TITLE, '', ''));

/**
 * GET /og/image/session-token/:token
 * OG image for a share link.
 */
ogRouter.get('/image/session-token/:token', async (c) => {
  const { token } = c.req.param();
  const card = await sessionCardForShareToken(c.get('db'), token);
  if (!card) {
    return c.json({ error: 'Invalid share link' }, 404);
  }
  return renderSessionCardImage(card.title, card.repo, card.workspace);
});

/** Renders the 1200x630 session card PNG. */
async function renderSessionCardImage(title: string, repo: string, workspace: string): Promise<Response> {
  const font = await getFont();

  // satori accepts virtual DOM objects — cast to satisfy React types
  const svg = await satori(
    ({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '1200px',
          height: '630px',
          backgroundColor: '#0a0a0a',
          padding: '60px',
          fontFamily: 'DM Sans',
          color: '#fafafa',
        },
        children: [
          // Top: branding
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      width: '40px',
                      height: '40px',
                      backgroundColor: '#22d3ee',
                      borderRadius: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '24px',
                      fontWeight: 700,
                      color: '#0a0a0a',
                    },
                    children: 'V',
                  },
                },
                {
                  type: 'span',
                  props: {
                    style: {
                      fontSize: '24px',
                      fontWeight: 600,
                      color: '#a1a1aa',
                    },
                    children: 'Valet',
                  },
                },
              ],
            },
          },
          // Center: session title
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: title.length > 60 ? '36px' : '48px',
                      fontWeight: 700,
                      lineHeight: 1.2,
                      color: '#fafafa',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    },
                    children: title,
                  },
                },
              ],
            },
          },
          // Bottom: repo + workspace
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                gap: '24px',
                fontSize: '28px',
                color: '#71717a',
              },
              children: [
                ...(repo
                  ? [
                      {
                        type: 'span',
                        props: {
                          style: { color: '#a1a1aa' },
                          children: repo,
                        },
                      },
                    ]
                  : []),
                ...(workspace
                  ? [
                      {
                        type: 'span',
                        props: {
                          children: workspace,
                        },
                      },
                    ]
                  : []),
              ],
            },
          },
        ],
      },
    }) as React.ReactNode,
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: 'DM Sans',
          data: font,
          weight: 400,
          style: 'normal',
        },
        {
          name: 'DM Sans',
          data: font,
          weight: 600,
          style: 'normal',
        },
        {
          name: 'DM Sans',
          data: font,
          weight: 700,
          style: 'normal',
        },
      ],
    }
  );

  const resvg = await Resvg.async(svg, {
    fitTo: { mode: 'width', value: 1200 },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return new Response(pngBuffer, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache',
    },
  });
}

/**
 * GET /og/meta/invite/:code
 * Returns OG metadata for an invite link (public, no auth)
 */
ogRouter.get('/meta/invite/:code', async (c) => {
  const { code } = c.req.param();

  const invite = await getInviteByCodeAny(c.get('db'), code);
  if (!invite) {
    return c.json({ error: 'Invite not found' }, 404);
  }

  const orgSettings = await getOrgSettings(c.get('db'));
  const orgName = orgSettings.name || 'Valet';

  const isExpired = new Date(invite.expiresAt) < new Date();
  const isAccepted = !!invite.acceptedAt;

  let description: string;
  if (isAccepted) {
    description = 'Invite already accepted';
  } else if (isExpired) {
    description = 'Invite expired';
  } else {
    description = `You've been invited as a ${invite.role}`;
  }

  const url = new URL(c.req.url);
  const imageUrl = `${url.origin}/og/image/invite/${code}`;

  return c.json({ title: `Join organization: ${orgName}`, description, imageUrl });
});

/**
 * GET /og/image/invite/:code
 * Generates a dynamic OG image (PNG) for an invite
 */
ogRouter.get('/image/invite/:code', async (c) => {
  const { code } = c.req.param();

  const invite = await getInviteByCodeAny(c.get('db'), code);
  if (!invite) {
    return c.json({ error: 'Invite not found' }, 404);
  }

  const orgSettings = await getOrgSettings(c.get('db'));
  const orgName = orgSettings.name || 'Valet';
  const roleLabel = `Invited as ${invite.role}`;

  const font = await getFont();

  const svg = await satori(
    ({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '1200px',
          height: '630px',
          backgroundColor: '#0a0a0a',
          padding: '60px',
          fontFamily: 'DM Sans',
          color: '#fafafa',
        },
        children: [
          // Top: branding
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      width: '40px',
                      height: '40px',
                      backgroundColor: '#22d3ee',
                      borderRadius: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '24px',
                      fontWeight: 700,
                      color: '#0a0a0a',
                    },
                    children: 'V',
                  },
                },
                {
                  type: 'span',
                  props: {
                    style: {
                      fontSize: '24px',
                      fontWeight: 600,
                      color: '#a1a1aa',
                    },
                    children: 'Valet',
                  },
                },
              ],
            },
          },
          // Center: org name
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: orgName.length > 40 ? '36px' : '48px',
                      fontWeight: 700,
                      lineHeight: 1.2,
                      color: '#fafafa',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    },
                    children: `Join organization: ${orgName}`,
                  },
                },
              ],
            },
          },
          // Bottom: role
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                fontSize: '28px',
                color: '#71717a',
              },
              children: [
                {
                  type: 'span',
                  props: {
                    style: { color: '#a1a1aa' },
                    children: roleLabel,
                  },
                },
              ],
            },
          },
        ],
      },
    }) as React.ReactNode,
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: 'DM Sans',
          data: font,
          weight: 400,
          style: 'normal',
        },
        {
          name: 'DM Sans',
          data: font,
          weight: 600,
          style: 'normal',
        },
        {
          name: 'DM Sans',
          data: font,
          weight: 700,
          style: 'normal',
        },
      ],
    }
  );

  const resvg = await Resvg.async(svg, {
    fitTo: { mode: 'width', value: 1200 },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return new Response(pngBuffer, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache',
    },
  });
});
