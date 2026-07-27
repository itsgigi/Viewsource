// Accesso GitHub per l'ingestion da repo (sourceType "git"): metadati via API
// REST e URL di clone autenticato. Scope iniziale: repo di proprietà
// dell'admin, anche private, via Personal Access Token in env.
//
// Punto di scelta unico per il token: se in futuro si passa a una GitHub App
// o OAuth, solo `getGithubToken` cambia — il resto del modulo resta identico.
// Il token non deve MAI finire in log o in dati persistiti.

const GITHUB_API = "https://api.github.com";

export function getGithubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN non configurato: necessario per l'ingestion da repo");
  }
  return token;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Accetta "https://github.com/owner/repo", "https://github.com/owner/repo.git", "owner/repo". */
export function parseRepoUrl(sourceUrl: string): RepoRef {
  const cleaned = sourceUrl.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const match = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+)$/) ?? cleaned.match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    throw new Error(`URL repo GitHub non riconosciuto: ${sourceUrl}`);
  }
  return { owner: match[1], repo: match[2] };
}

/** URL di clone con token embedded — usato SOLO come target ephemeral per simple-git, mai loggato o persistito. */
export function cloneAuthUrl({ owner, repo }: RepoRef): string {
  const token = getGithubToken();
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

export interface RepoMetadata {
  description: string | null;
  topics: string[];
  language: string | null;
  license: string | null; // SPDX id, es. "MIT" — null se non rilevata dall'API
  homepage: string | null; // URL del sito deployato, se presente
  defaultBranch: string;
}

export async function fetchRepoMetadata({ owner, repo }: RepoRef): Promise<RepoMetadata> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers: {
      Authorization: `Bearer ${getGithubToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} per ${owner}/${repo}: impossibile leggere i metadati`);
  }

  const data = await res.json();

  return {
    description: data.description ?? null,
    topics: Array.isArray(data.topics) ? data.topics : [],
    language: data.language ?? null,
    license: data.license?.spdx_id && data.license.spdx_id !== "NOASSERTION" ? data.license.spdx_id : null,
    homepage: data.homepage || null,
    defaultBranch: data.default_branch ?? "main",
  };
}
