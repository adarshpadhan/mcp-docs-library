# MCP College Library — Product and Implementation Plan

## 1. Product idea

Build a TypeScript-based MCP server for college students that lets verified
students access a trusted, searchable library of course contents, previous-year
questions (PYQs), notes, openly licensed books, and related study material from AI
clients such as ChatGPT, Gemini, Claude, and IDE assistants that support MCP.

The first audience is students whose college email account is managed under the
college's Google Workspace domain. Google sign-in verifies control of that
institutional account; the application then applies course, semester, and content
entitlements.

The server should not merely expose files. It should provide citation-backed,
permission-aware study actions:

- Find relevant material by subject, university, course, semester, year, topic, and
  difficulty.
- Answer questions using retrieved library content with page/section citations.
- Explain a concept at a selected level.
- Create revision plans, quizzes, flashcards, and PYQ practice sets.
- Locate similar questions and show recurrence across years.
- Link answers back to the original document and page.

### Important integration constraint

MCP is a protocol, not a universal login or distribution mechanism. Each AI client
must support MCP and its particular transport/authentication flow. Therefore:

1. Implement a standards-compliant remote MCP endpoint (Streamable HTTP; keep an
   SSE compatibility endpoint only if a target client requires it).
2. Provide a small local/stdio launcher for desktop clients and development.
3. Maintain client-specific setup instructions and test each client against the
   same server contract.
4. Do not promise that every ChatGPT or Gemini surface can connect directly; access
   depends on the product plan, client, and MCP support available at integration
   time.

### Content and licensing policy

The library should accept and redistribute only content that is clearly permitted:

- Original college-published material with written authorization.
- Public-domain material.
- Openly licensed material whose license permits the intended use and
  redistribution, with attribution and license metadata retained.
- Student/faculty contributions submitted under an explicit contributor license
  or permission agreement.

“Available online” is not the same as open source or legally redistributable.
Commercial textbooks, publisher PDFs, paid course notes, and scanned books must
not be imported merely because students can access them elsewhere. For every
published document, store the license type, attribution, source URL, rights
holder, permitted uses, region/expiry restrictions, and takedown contact. Mark
uncertain material as unpublished until reviewed by an administrator.

## 2. Recommended architecture

```text
Upload/API
   -> validation and virus scan
   -> object storage (original files)
   -> ingestion queue
   -> text extraction/OCR
   -> structure + metadata extraction
   -> chunking and embeddings
   -> PostgreSQL + pgvector

AI client
   -> authenticated MCP transport
   -> authorization and tenant/entitlement checks
   -> catalog/search/retrieval tools
   -> citations and signed document links
```

### Suggested stack

- **Runtime:** Node.js 22 LTS, TypeScript, npm/pnpm.
- **MCP:** Official TypeScript MCP SDK; use the current stable SDK and pin versions.
- **HTTP:** Fastify (or the SDK's supported HTTP integration), Zod validation,
  Pino structured logging.
- **Database:** PostgreSQL 16+ with `pgvector`; Drizzle ORM or Prisma. Prefer one
  query layer rather than mixing ORMs and raw SQL casually.
- **Search:** PostgreSQL full-text search + pgvector hybrid retrieval. Add a
  dedicated search engine only after measuring a real need.
- **Files:** Cloudflare R2 for private originals, accessed through its S3-compatible
  API; never store large PDFs in database rows.
- **Workers:** Redis + BullMQ initially, or a managed queue. Keep ingestion
  asynchronous and retryable.
- **Extraction:** PDF text extraction, DOCX parsing, and OCR for scanned PDFs.
  Store extraction confidence and page boundaries.
- **Embeddings:** Provider abstraction so the project can switch models without
  rewriting retrieval. Store model name/version with every embedding.
- **Deployment:** Cloudflare Workers/Pages + R2 for the website/upload edge,
  Oracle Ampere for API/MCP/PostgreSQL/queue, and an outbound-only local admin
  worker for OCR.

## 2A. Free hosting plan: Oracle Cloud Ampere

Yes, an Oracle Cloud Always Free Ampere ARM64 VM can host the first version. It
is suitable for an MVP because the TypeScript server, PostgreSQL, Redis, and an
ingestion worker can run in ARM64 Docker containers. Confirm the current Always
Free limits and regional capacity during account creation; capacity is not
guaranteed in every region and Oracle requires account verification.

### Recommended first deployment

```text
Cloudflare Workers/Pages + private R2
  - Student website and upload orchestration
  - Short-lived presigned upload URLs

Oracle Ampere VM (ARM64)
  - Caddy or Nginx: TLS and reverse proxy
  - API and MCP server: Node.js container
  - Queue and indexing worker
  - PostgreSQL + pgvector: database
  - Redis: queue and rate-limit state

Admin MacBook Air
  - Local-ingest CLI/worker
  - Licensed metadata creation
  - UnlimitedOCR processing
  - Outbound HTTPS push of reviewed extraction packages
```

Keep uploaded originals in the private R2 bucket rather than on the Oracle VM
boot disk. R2 is private for operational safety; the frontend can provide a
short-lived signed download URL after checking that the document is published
and its raw-file license allows download. Use R2 lifecycle rules and encrypted
backups to a second location.

### Oracle-specific precautions

- Use ARM64-compatible Docker images and native modules.
- Expose only ports 80/443 publicly; keep PostgreSQL and Redis on a private
  Docker network.
- Configure DNS, HTTPS, firewall rules, security updates, and SSH protection.
- Monitor memory during OCR and embedding jobs; separate workers from MCP
  request handling where possible.
- Schedule encrypted database dumps and test restoring them. A free VM is not
  a backup or high-availability strategy.
- Keep a migration path to managed PostgreSQL and object storage before serving
  a whole college.

### Free or low-cost alternatives

- **Supabase:** hosted PostgreSQL, pgvector, storage, and Google authentication;
  check current free-plan limits and inactivity policies.
- **Google Cloud Run plus external PostgreSQL:** convenient for a stateless MCP
  API, but quotas and database costs vary over time.
- **Render, Fly.io, or Railway:** easy prototypes, but free plans may sleep or
  limit storage. Do not keep the only copy of documents there.
- **A second small provider for backups:** safer than keeping production and the
  only backup in the same Oracle account.

For this project, use Oracle Ampere for the MVP, create encrypted off-server
backups from day one, and move stateful services to managed infrastructure when
reliability or usage justifies it.

## 2B. Student website and upload workflow

The student frontend will run on Cloudflare Workers/Pages, with original uploads
stored initially in a private Cloudflare R2 bucket. Oracle should not receive
large browser uploads through the API. Instead, the Cloudflare layer creates a
short-lived presigned upload URL, records the upload metadata, and notifies the
Oracle API that a new ingestion job is available.

Add a web frontend for the student experience, but do not let a student upload
become immediately searchable. The website should support:

- Google Workspace sign-in and student profile.
- Course/semester browsing and search.
- Drag-and-drop upload with file type, size, and license/permission declaration.
- Upload progress, processing status, rejection reason, and takedown request.
- Document preview only after authorization; never expose another student's
  private upload by guessing a URL.
- Admin review queue for metadata, licensing, OCR quality, duplication, and
  publication.

Suggested frontend stack:

- Next.js or Vite + React + TypeScript.
- A shared typed API client generated from the server contract.
- Direct browser-to-private R2 upload using short-lived presigned URLs, so large
  files do not pass through a Worker or the Node.js API.
- Cloudflare stores only the upload metadata and private R2 object key until the
  Oracle API accepts the job.
- Oracle stores the canonical document record, processing state, and publication
  status; R2 remains the original-file source until retention/deletion policy
  allows removal.

Suggested states:

```text
draft -> uploaded -> queued -> processing -> review
      -> rejected / needs_changes / approved -> published
      -> suspended / takedown_requested / deleted
```

Students may submit materials, but only an authorized administrator or delegated
moderator should approve publication. If the college has approved student
sharing, record the contributor's permission and attribution at upload time.
After approval, the original raw file may be downloadable from the frontend
whenever its recorded license permits public download.

## 2C. Cloudflare R2 to Oracle local-ingest split

Use Cloudflare for the public frontend and original-file intake, Oracle for the
API, database, queue, catalog, and MCP server, and a separate trusted admin
MacBook Air for metadata creation and UnlimitedOCR processing. The MacBook pulls
an explicitly assigned job from Oracle, downloads the original from R2, processes
it with UnlimitedOCR, and pushes the reviewed extraction package to Oracle.

Recommended flow:

```text
Cloudflare Workers/Pages student website
  -> short-lived presigned upload URL
  -> private Cloudflare R2 original
  -> Oracle ingestion job: uploaded
  -> local admin worker claims job from Oracle
  -> worker downloads original from R2
  -> OCR/text extraction + page-preserving validation
  -> admin reviews metadata, rights, and OCR sample
  -> encrypted extraction manifest pushed to Oracle
  -> Oracle indexes chunks and embeddings
  -> administrator publishes
```

The MacBook worker should authenticate to Oracle with a narrowly scoped,
revocable service credential or device-bound OAuth token and should claim jobs
with a lease. It must not expose its local filesystem or an admin port to the
public internet. Prefer outbound HTTPS connections from the MacBook; do not
require Oracle to connect into the admin machine. Keep the original file in R2
and the extracted text version separately so UnlimitedOCR can be rerun.

### R2 security and lifecycle

- Keep the R2 bucket private and disable public bucket access.
- Use separate credentials for the Cloudflare upload service, local-ingest
  worker, and Oracle API; each credential should have the smallest possible
  bucket/path permissions.
- Use object keys that do not contain student email addresses or student IDs.
- Validate file size, MIME type, checksum, and magic bytes before creating a
  processing job. Scan the file before opening it on the admin machine.
- Issue a short-lived, single-object download URL to the local worker only after
  it claims the job. Never expose R2 credentials to the browser.
- Verify the SHA-256 checksum before and after transfer. Make the job and
  checksum idempotent so retries cannot create duplicate documents.
- Do not expose OCR output or originals through a predictable R2 URL. All
  downloads must pass a publication/license check and use a short-lived signed
  URL. “Downloadable from the frontend” must not mean that the R2 bucket is
  publicly exposed.
- Define retention explicitly: preserve the original when required for
  attribution/audit, or delete it after successful processing only when the
  college's rights and recovery policy permit deletion.

### Job handshake and failure handling

Use an explicit state machine rather than a single “processed” flag:

```text
uploaded -> claimed -> downloading -> processing -> awaiting_review
          -> failed_retryable / failed_permanent
awaiting_review -> approved -> indexing -> published
                 -> rejected / needs_changes
```

Each job should include an attempt count, lease expiry, worker ID, checksum,
parser/OCR versions, error code, and timestamps. Expired leases must return to
the queue safely. The local worker should upload a manifest atomically, and
Oracle should validate its schema and checksum before replacing the job output.

### UnlimitedOCR on the MacBook Air

UnlimitedOCR is the selected OCR engine for the initial release. Before
processing real student material, the college administrator should verify that
its license and terms permit this workflow, including local processing,
commercial/non-commercial use if applicable, redistribution of generated output,
and no unwanted retention or training use. The project code and ingested content
will use the open-source UnlimitedOCR implementation and should retain its
license, copyright notices, source link, and dependency attribution. Open-source
OCR software makes the processing toolchain inspectable and redistributable; it
does not automatically grant rights to the documents being processed.

Wrap UnlimitedOCR behind a local-ingest adapter so the rest of the system only
depends on a stable manifest contract. Record the engine name/version,
configuration, language, confidence, processing timestamp, and parser version.
Keep a fallback for files UnlimitedOCR cannot process:

- Text-native PDFs/DOCX: local deterministic extraction first.
- Scanned PDFs: a college-approved local OCR fallback such as OCRmyPDF +
  Tesseract, with confidence and page outputs retained.
- Difficult layouts/tables: an optional approved OCR provider or manual review.

OCR output is not authoritative: show low-confidence pages to the administrator
and block publication when page citations are unreliable. Never silently replace
the original file with OCR output.

## 2D. Five separate licensing rules

“The project is open source” must be implemented as five explicit policies:

1. **Source code:** publish the repository under a chosen OSI-approved license
   (for example, Apache-2.0 or MIT), including dependency notices and a
   `THIRD_PARTY_NOTICES` file.
2. **Local processing toolchain:** publish local-ingest adapters, scripts, and
   configuration under the project code license, and retain UnlimitedOCR's
   original license and notices. Record the exact UnlimitedOCR version used.
3. **Raw uploaded files:** publish or permit frontend downloads only for files
   whose rights explicitly allow copying and redistribution. Store a raw-file
   license and attribution separately from the processed-output license. Public
   domain, CC0, or a compatible Creative Commons/open-content license may allow
   download; “student uploaded it” or “the college approved the project” alone
   is not sufficient.
4. **Metadata:** publish metadata under a data-friendly open license such as
   CC0 or CC BY 4.0, depending on the college's legal approval. Keep attribution,
   source URL, creator, license identifier, and provenance for every record.
5. **Processed artifacts on Oracle:** extracted text, page manifests, normalized
   content, chunks, embeddings, OCR derivatives, generated summaries, and
   indexes have a separately recorded output license. The Oracle-stored output
   must be no more permissive than the raw-file rights unless the rights holder
   explicitly authorizes the transformation and redistribution. Store the
   output license, version, attribution, source document ID, and provenance with
   every published document version.

For student submissions, require a declaration that the contributor owns the
rights or has permission to share the material under the selected open license.
Store the declaration, contributor identity, timestamp, license, and takedown
contact. Content with unknown, “educational use only,” or non-redistributable
terms cannot be made openly downloadable; keep it private/unpublished or reject
it, according to the college policy. Exclude rejected/private material from
embeddings and MCP search.

### Raw-file and processed-file publication states

Track raw and processed availability independently:

```text
raw:      private -> downloadable -> restricted -> deleted
processed: withheld -> review -> published -> suspended -> deleted
```

An administrator may publish the processed OCR/search representation while
keeping the raw file restricted, or publish both only when both licenses permit
it. The frontend must display the applicable raw-file and processed-artifact
license before download, with attribution and source information.

## 3. MCP surface design

Keep the initial MCP surface small, read-focused, and easy to authorize.

### Resources

- `library://subjects` — available subjects and course hierarchy.
- `library://documents/{documentId}` — document metadata and access status.
- `library://documents/{documentId}/pages/{pageNumber}` — extracted page text
  where the user is entitled to read it.
- `library://collections/{collectionId}` — curated syllabus or exam collections.

### Tools

- `search_library`
  - Input: query, subject/course filters, year, document type, language, limit.
  - Output: normalized results with title, document ID, page, snippet, score,
    access status, and citation data.
- `get_document`
  - Input: document ID, optional page range.
  - Output: metadata and bounded text, never an unbounded full-book response.
- `retrieve_context`
  - Input: question, filters, token budget.
  - Output: deduplicated passages with page citations and retrieval scores.
- `find_similar_questions`
  - Input: question text or question ID, filters.
  - Output: similar PYQs, years, exams, and source citations.
- `generate_practice_set`
  - Input: subject/topic, difficulty, count, year constraints.
  - Output: question IDs and citations; answer generation should remain visibly
    separate from source retrieval.
- `create_study_plan`
  - Input: exam date, subjects, available hours, target topics.
  - Output: a plan grounded in catalog coverage and explicitly marked assumptions.

### Prompts

- `answer_with_citations`
- `explain_from_library`
- `revise_topic`
- `practice_previous_questions`

Prompts should guide the client to cite sources, distinguish retrieved facts from
model-generated explanations, and say when the library does not contain enough
evidence. Never hide uncertainty behind a confident answer.

## 4. Ingestion pipeline

1. Accept an authenticated student upload or an approved admin/import job.
2. Validate MIME type, size, checksum, and file extension; scan for malware.
3. Save the original to private object storage and create an ingestion record.
4. Queue the job without making it searchable or publicly downloadable.
5. A trusted local admin worker claims the job and extracts text while preserving
   page number, heading, table, and figure boundaries.
6. Normalize text without destroying the original extracted representation.
7. Extract or request metadata: institution, course, subject, semester, exam,
   academic year, language, author, edition, document type, license, and rights.
8. Split into citation-friendly chunks (usually 400–800 tokens with modest
   overlap), keeping document/page/section relationships.
9. Generate embeddings asynchronously and record model/version and failures.
10. Index PostgreSQL full-text fields and vector embeddings only after review.
11. Run quality checks: empty pages, low OCR confidence, duplicate checksum,
    missing metadata, broken page citations, and suspicious extraction.
12. Publish only after moderation and rights/access checks pass.

Design ingestion as idempotent: the same checksum and parser/model versions should
not create duplicate active documents.

## 5. Core data model

Recommended initial tables:

- `users`, `organizations`, `memberships`, `roles`
- `documents`, `document_versions`, `document_pages`
- `subjects`, `courses`, `topics`, and join tables
- `exams`, `questions`, `question_options`, `question_answers`
- `chunks`, `chunk_embeddings`, `chunk_search`
- `collections`, `collection_documents`
- `licenses`, `entitlements`, `access_audit_logs`
- `ingestion_jobs`, `ingestion_errors`, `moderation_reviews`
- `upload_permissions`, `takedown_requests`, `ocr_runs`

Useful invariants:

- Every chunk belongs to a document version and has a page reference when known.
- Every answer or generated study artifact stores source chunk IDs.
- Published documents require an explicit rights/status value.
- Soft-delete documents and retain audit history; do not silently invalidate
  citations.

## 6. Retrieval and answer quality

Use hybrid retrieval:

1. Apply authorization and metadata filters first.
2. Run PostgreSQL full-text and vector searches in parallel.
3. Fuse/rerank results, deduplicate adjacent chunks, and enforce a token budget.
4. Return stable citation identifiers and signed links only for authorized users.
5. Optionally rerank with a cross-encoder after measuring latency and quality.

Evaluation should include a small, versioned benchmark of real student questions:

- Recall of the correct document/page.
- Citation precision and citation completeness.
- Answer faithfulness to retrieved passages.
- “Not enough information” accuracy.
- p50/p95 retrieval latency and token cost.

Do not evaluate only on whether an LLM response sounds plausible.

## 7. Security, privacy, and rights

- Use OAuth 2.1/OIDC for remote clients; short-lived access tokens and scoped
  permissions.
- Use PKCE for interactive clients and rotate refresh tokens.
- Enforce tenant, role, collection, and document entitlements inside every tool.
- Never trust document IDs or filters supplied by the model as authorization.
- Keep originals private; issue short-lived signed URLs after an access check.
- Rate-limit searches, retrieval, downloads, and expensive generation workflows.
- Redact secrets and personal data from logs; maintain access audit logs.
- Add prompt-injection defenses around retrieved documents: treat document text
  as untrusted data, not instructions.
- Define copyright policy before importing books. Store license/permission,
  takedown, attribution, and region/expiry metadata. Do not ingest or redistribute
  copyrighted books without appropriate rights.
- Provide deletion, correction, export, and takedown workflows.

## 7A. Google OAuth for college students

Google OAuth is a suitable first authentication method. Use OpenID Connect
identity data only for login and request the minimum scopes (`openid`, `email`,
and `profile` only if needed). Do not request Drive, Gmail, or other API scopes
unless a separate feature genuinely needs them.

### Recommended authorization flow

1. Register a Google OAuth web application with exact HTTPS redirect URIs.
2. Use Authorization Code + PKCE, a state value, and a nonce.
3. Exchange the code server-side and validate the ID token's issuer, audience,
   signature, expiry, nonce, and `email_verified`.
4. Require the institution's Google Workspace domain. Validate the token's
   `hd` claim; never accept a user-supplied domain as proof.
5. Check the normalized email against an approved college roster or require an
   administrator-approved invitation. A domain check alone is not enough.
6. Use Google's stable `sub` claim as the external identity key, not email.
7. Issue the application's own short-lived session/access token and refresh
   token, and revoke local sessions when entitlement ends.
8. For remote MCP, enforce the MCP client's bearer token at the MCP endpoint
   and map it to the local user and scopes. Google login and MCP client
   authorization are related but are not automatically the same flow.

### Student-ID handling

If the student ID is only a number, do not use it as a password or send it to
Google. Store an encrypted or hashed roster identifier and link it to the
Google `sub` after an admin-approved match. Even if the ID is encoded in the
institutional email address, validate it against the college roster rather than
trusting a regular expression alone.

### Authentication choices

- **Recommended MVP:** Google OIDC directly in the TypeScript server using a
  maintained library, with local `users` and `sessions` tables.
- **Managed alternative:** Supabase Auth or Firebase Authentication for Google
  sign-in, while document authorization and MCP scopes remain in your database.
- **Self-hosted alternative:** Keycloak or Authentik on Oracle. This gives
  control but adds upgrades, backups, and operational burden.
- **Avoid initially:** implementing OAuth token validation, refresh-token
  rotation, consent, and account linking from scratch.

Google OAuth is free for this login scenario, but the Google Cloud OAuth consent
screen and redirect URI configuration still need to be set up correctly. If the
app is restricted to a Workspace organization, coordinate with the college's
Workspace administrator. Personal Gmail accounts should not pass the
institutional authorization rule.

For the first release, the simplest policy is:

- Allow only accounts from the configured college Workspace domain.
- Require `email_verified=true` and a valid, non-expired Google ID token.
- Store the verified domain in configuration, not in client request data.
- Optionally map email/student ID to a roster so access can be limited by
  department, course, semester, or graduation status.
- Re-check membership at login and periodically; support immediate local
  deactivation even if the Google account still exists.

The Google domain proves institutional account ownership, not that a student is
enrolled in every course. Course-level access should therefore come from a
maintained roster, enrollment import, invitation, or administrator assignment.

### Application scopes

Define application scopes independently of Google scopes:

- `library:read` — search and retrieve permitted content.
- `library:practice` — create practice sets and study artifacts.
- `library:admin` — upload, moderate, publish, and revoke content.

Every MCP tool must enforce these scopes and document entitlements server-side.
Never rely on the AI client or model to enforce authorization.

## 8. API and repository shape

Suggested monorepo layout:

```text
backend/
  backend/             # API, remote MCP transport, and tool registration
  Dockerfile           # Oracle ARM64 backend image
  docker-compose.yml    # Oracle backend + database + Redis
packages/
  db/                  # schema, migrations, repositories
  domain/              # typed entities and authorization policies
  ingestion/           # parsers, OCR adapters, chunking
  retrieval/           # FTS/vector search, reranking, citations
  auth/                # OIDC, token verification, entitlements
  storage/             # presigned uploads, private object keys, signed downloads
  config/              # validated environment configuration
cloudflare/            # Cloudflare Workers/Pages and R2 deployment boundary
backend/                # backend deployment boundary
local-ingest/          # Admin MacBook deployment boundary
infra/
  docker-compose.yml
  migrations/
tests/
  retrieval/
  contract/
  ingestion/
```

Keep MCP adapters thin. Business logic should live in typed services that can be
tested without launching an AI client.

## 9. Phased roadmap

### Phase 0 — decisions and proof of concept

- Confirm target MCP clients and their current transport/auth requirements.
- Adopt an open-content policy and document acceptance rules for each license.
- Create a tiny benchmark corpus (for example, 20–50 permitted documents).
- Prove upload → extract → chunk → embed → hybrid search → cited result.

### Phase 1 — useful read-only MVP

- Student website with upload status and admin review dashboard.
- TypeScript MCP server with stdio and remote HTTP transports.
- PostgreSQL/pgvector schema and migrations.
- Student upload, private object storage, MacBook/UnlimitedOCR worker, and
  metadata review.
- `search_library`, `get_document`, and `retrieve_context`.
- OAuth/OIDC, entitlements, rate limits, structured logs, and citations.
- Docker Compose local setup and client connection documentation.

### Phase 2 — education workflows

- Question/answer structure for PYQs.
- Similar-question detection and filters by exam/year/topic.
- Practice sets, flashcards, and study plans.
- Evaluation benchmark and regression tests for retrieval/citations.

### Phase 3 — production hardening

- Durable queue, OCR quality review, moderation workflow, backups, monitoring,
  tracing, alerting, and disaster recovery.
- Organization/institution tenancy and paid/private collections if required.
- Client-specific OAuth registration and production onboarding.

## 10. Definition of done for the MVP

- A permitted PDF can be ingested and published with page-preserving text.
- A published raw file can be downloaded from the frontend whenever its recorded
  raw-file license permits public reuse.
- A student can upload a document without making it public or searchable.
- An authorized local admin worker can process OCR jobs without public inbound
  access.
- An administrator can review rights, metadata, OCR quality, and publish status.
- An authorized MCP client can search and retrieve relevant passages.
- Every returned passage has a stable document/page citation.
- Unauthorized users cannot retrieve metadata, text, or signed file links.
- Failed ingestion jobs are visible and retryable.
- Automated tests cover auth boundaries, retrieval filters, citations, and MCP
  tool input/output schemas.
- A documented setup works locally with Docker Compose and at least one real MCP
  client.

## 11. Immediate next actions

1. Confirm first departments/courses and student eligibility source for the
   configured `kiit.ac.in` Google Workspace domain.
2. Select the first two MCP clients to support and verify their current MCP
   connection requirements.
3. Define the open-content acceptance policy, attribution format, takedown
   process, and first permitted corpus.
4. Create the Cloudflare Worker/Pages project, private R2 bucket, upload
    presigning, lifecycle rules, and upload-size limits.
5. Create the Oracle Ampere VM, DNS, HTTPS, firewall, encrypted backup, and
    monitoring setup.
6. Bootstrap the monorepo, TypeScript config, linting, test runner, and environment
    validation.
7. Add PostgreSQL + pgvector migrations for documents, pages, chunks, users,
    sessions, scopes, and access control.
8. Configure Google OAuth and test domain, roster, revocation, and account-linking
    rules with test accounts.
9. Build the student upload flow, private storage, job states, and admin review
    dashboard.
10. Implement the MacBook local-ingest worker around UnlimitedOCR, with a
     deterministic extraction fallback and outbound-only Oracle authentication.
11. Implement `search_library` and `retrieve_context` with citations before adding
    generative study tools.
12. Build a retrieval, licensing, OCR-quality, and authorization benchmark and use it as a
    release gate.

## Current status

- [x] Product concept and integration constraints documented.
- [x] Proposed TypeScript/PostgreSQL/MCP architecture documented.
- [x] Initial MCP resources, tools, prompts, and data model proposed.
- [x] Ingestion, retrieval, security, rights, and evaluation approach proposed.
- [x] Oracle Ampere hosting and Google OAuth/college authorization approach proposed.
- [x] College-student audience, domain verification, and open-content policy documented.
- [x] Student website, admin review, and local OCR ingestion workflow documented.
- [x] Confirm college Workspace domain as `kiit.ac.in`.
- [ ] Confirm roster/enrollment source and administrator approval.
- [ ] Confirm first permitted course-content corpus and license metadata.
- [ ] Confirm UnlimitedOCR license/privacy terms, MacBook processing workflow,
  and approved open licenses for code, metadata, and documents.
- [x] Cloudflare Workers/Pages + private R2 upload and Oracle push architecture documented.
- [x] Initial TypeScript monorepo scaffold, contracts, API health endpoint, stdio MCP entrypoint, and database migration created.
- [x] Typecheck, API health smoke test, and local-ingest manifest smoke test passed.
- [x] Backend/MCP source is packaged as `@college-library/backend` in the deployment workspace, with Dockerfile and Compose support.
- [x] Oracle stack built and started with Podman Desktop; PostgreSQL migration, Redis, backend health, and stdio MCP initialization verified.
- [x] Local processing package moved into `local-ingest` deployment boundary.
- [x] Unlimited-OCR source installed and pinned under `local-ingest/vendor/` with a manifest-producing adapter.
- [x] Apple Silicon Mac adapter installed and verified against the supplied
  two-page PYQ; output preserves one Markdown file per page.
- [x] OCR heading extraction populates course code `CS-30013`, subject
  `Data Mining and Data Warehousing`, semester `5`, and exam year `2026`.
- [x] MCP file catalog reads processed manifests/pages and exposes the supplied
  PYQ through `search_library`, `retrieve_context`, and Streamable HTTP `/mcp`.
- [x] Documented temporary Gemini access through a Cloudflare Quick Tunnel;
  the development MCP stack and tunnel were stopped after testing.
- [x] Removed unused Podman build layers and an orphaned anonymous volume;
  retained only the backend/runtime images and project PostgreSQL volume.
- [x] Removed the local Podman machine and container storage after development
  testing; project source and OCR assets remain intact.
- [x] Deployed the backend, PostgreSQL/pgvector, and Redis to the Oracle VM
  with Docker Compose; remote health and MCP search verified on the VM.
- [x] Migrated the library catalog from file-backed search to PostgreSQL,
  including page/chunk synchronization and PostgreSQL full-text search.
- [x] Added and verified the `semantic_search` MCP tool and the verified
  document raw-PDF resource template; vector results remain inactive until an
  embedding provider and chunk embeddings are configured.
- [x] Verified the remote MCP endpoint end-to-end for PostgreSQL search,
  citation retrieval, subject discovery, and the CS-30013 raw PDF resource.
- [x] Added subject short-name metadata (for example, `DMDW` for Data Mining
  and Data Warehousing) and exposed it in search results.
- [x] Improved search fallback behavior so a filtered document remains
  discoverable when OCR wording does not match every query term; citations now
  include the full page excerpt needed by AI clients.
- [x] Added `get_document_text`, which returns exact page-preserving OCR text
  without summarization, and verified it through the public MCP tunnel.
- [x] Bootstrap project and local development environment.
- [x] Implement database schema and ingestion proof of concept.
- [x] Implement and test the first MCP tools.

## 12. MVP decisions and implementation defaults

The following defaults make the project ready for scaffolding. They are
deliberately conservative and can be changed through configuration or a later
architecture decision record.

### Identity and access

- **Initial identity provider:** Google OpenID Connect.
- **Allowed users:** verified accounts from the configured `kiit.ac.in` college
  Workspace domain.
- **Student eligibility:** domain verification for the first prototype, followed
  by an admin-managed roster/enrollment import before wider release.
- **Default student scope:** `library:read` and upload-submission permission.
- **Admin scope:** `library:admin`; admins can review, publish, suspend, and
  delete content.
- **Course access:** open to verified college students in the prototype;
  course/department restrictions are added when enrollment data is available.

### Licensing defaults

- **Repository code:** Apache-2.0.
- **Metadata:** CC BY 4.0 by default, with CC0 used only where the college
  confirms that attribution is not required.
- **Raw files:** public download only when the document has an explicit
  public-domain, CC0, compatible Creative Commons, or written college/student
  redistribution permission.
- **Processed artifacts:** inherit the raw document's restrictions unless a
  rights holder explicitly grants a separate license. Unknown or
  “educational-use-only” documents are not published.
- **Required records:** license identifier, attribution, source URL, contributor,
  permission declaration, provenance, and takedown contact.

### Initial content and file limits

- **First corpus:** permitted course notes, openly licensed books, faculty
  material, and PYQs from one department or pilot course.
- **Initial formats:** PDF, DOCX, PPTX, and common image formats.
- **Initial upload limit:** 100 MB per file and 500 pages per document, with
  configurable limits rather than hard-coded values.
- **Initial language:** English, with OCR language configuration stored per job.
- **Raw retention:** preserve the original in R2 until processing, review,
  publication, backup, and any takedown period are complete.

### Processing defaults

- **OCR machine:** admin MacBook Air running the open-source UnlimitedOCR
  version recorded in each `ocr_run`.
- **Processing direction:** MacBook pulls jobs and pushes results; Oracle never
  opens an inbound connection to the MacBook.
- **Fallback:** deterministic text extraction first, then an approved local OCR
  fallback for files UnlimitedOCR cannot process.
- **Review:** no automatic publication; every first-release document requires
  admin rights and OCR review.
- **Output contract:** versioned page-preserving manifest containing source
  checksum, page text, metadata, engine/version, confidence, and provenance.

### Deployment defaults

- **Frontend:** Cloudflare Workers/Pages.
- **Original files:** private Cloudflare R2 bucket with signed upload/download
  URLs and no public bucket access.
- **Backend:** Oracle Ampere ARM64 VM running the API, MCP server, PostgreSQL
  with pgvector, Redis, and indexing worker in Docker Compose.
- **Public network:** only HTTPS exposed; PostgreSQL and Redis remain private.
- **Backups:** encrypted PostgreSQL dumps and R2 backup copies on a separate
  provider or storage account, with a tested restore procedure.
- **First MCP transport:** remote Streamable HTTP; provide stdio for local
  development and compatibility.

### Initial supported clients

- **Primary test client:** Claude Desktop or another client with stable remote
  MCP support.
- **Secondary test client:** ChatGPT or Gemini only after verifying that the
  selected account/product surface supports the required remote MCP flow.
- **Client policy:** each client receives its own setup and authentication
  documentation; no shared student credential is used.

### Admin operations

- One college-approved admin is sufficient for the pilot; support multiple
  admins through roles from the beginning.
- The MacBook worker is manually started or scheduled by the admin, not exposed
  as a public service.
- Failed jobs are retryable, leased, auditable, and never silently discarded.
- A document is searchable only after its processed artifact is approved and
  indexed.

These defaults are the implementation baseline. Any change affecting
redistribution rights, student privacy, authentication, or public exposure must
be reviewed by the college administrator before deployment.

### Fresh MCP client compatibility milestone (2026-09-18)

- Added a stateless POST fallback for clients that do not preserve the
  `Mcp-Session-Id` header between fresh fetch requests.
- Verified a fresh public request without a session header successfully returned
  the DMDW search result.

### OAuth discovery compatibility milestone (2026-09-18)

- Removed the incomplete RFC 9728 and OAuth authorization-server discovery
  endpoints after Codex exposed non-functional CIMD/DCR/Auto authentication
  options. The MCP endpoint remains explicitly public until a complete OAuth
  broker, token validation, and college-domain enforcement are deployed.

### PDF download compatibility milestone (2026-09-18)

- Added `GET /api/v1/documents/:documentId/file` for clients that cannot
  consume MCP `application/pdf` embedded resources.
- The endpoint validates the published document through the library catalog and
  streams the original PDF with a download filename.
- Administrators can use the configured bearer token; MCP clients call
  `create_document_download_link` with either one `documentId` or 1–20 `documentIds`
  to receive a 10-minute signed HTTPS ZIP URL.
- Fixed `archiver` v8 ESM export compatibility and verified the public ZIP contains the renamed DMDW PDF with a valid archive checksum.
- The signing endpoint is a compatibility bridge; replace or supplement it with
  Google OIDC-backed student authorization and document entitlements before
  public production use.
