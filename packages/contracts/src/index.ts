import { z } from 'zod';

export const documentTypeSchema = z.enum(['notes', 'pyq', 'book', 'course-content', 'other']);
export const licenseSchema = z.object({
  identifier: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url().optional(),
  attribution: z.string().min(1),
});

export const uploadJobSchema = z.object({
  documentId: z.string().uuid(),
  objectKey: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  documentType: documentTypeSchema,
  courseCode: z.string().min(1),
  title: z.string().min(1),
  rawLicense: licenseSchema,
});

export type UploadJob = z.infer<typeof uploadJobSchema>;

export const licenseStatusSchema = z.enum(['verified', 'pending_review', 'rejected']);
export const ingestionMetadataSchema = z.object({
  title: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  documentType: documentTypeSchema,
  courseCode: z.string().min(1),
  subject: z.string().default('Unknown'),
  subjectShortName: z.string().default(''),
  semester: z.string().default('Unknown'),
  examYear: z.string().default('Unknown'),
  language: z.string().min(2),
  contributor: z.string().default('Unknown'),
  sourceUrl: z.string().url().optional(),
  rawLicense: licenseSchema,
  processedLicense: licenseSchema,
  licenseStatus: licenseStatusSchema,
  rightsNotes: z.string().default(''),
});

export type IngestionMetadata = z.infer<typeof ingestionMetadataSchema>;

export const ingestionManifestSchema = z.object({
  documentId: z.string().uuid(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  ocrEngine: z.string().min(1),
  ocrVersion: z.string().min(1),
  parserVersion: z.string().min(1),
  language: z.string().min(2),
  processedAt: z.string().datetime(),
  pages: z.array(
    z.object({
      pageNumber: z.number().int().positive(),
      text: z.string(),
      confidence: z.number().min(0).max(1).optional(),
    }),
  ),
  metadata: ingestionMetadataSchema,
});

export type IngestionManifest = z.infer<typeof ingestionManifestSchema>;
