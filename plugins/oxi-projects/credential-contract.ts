import { z } from 'zod';

export const bbProjectIdSchema = z.string().startsWith('proj_');

export const jiraBaseUrlSchema = z
  .string()
  .trim()
  .transform((value, context) => {
    if (!value) return '';
    try {
      const url = new URL(value);
      const hasExplicitPort = /^https:\/\/[^/?#]+:\d+(?:[/?#]|$)/iu.test(value);
      const isAtlassian =
        url.hostname === 'atlassian.net' ||
        url.hostname.endsWith('.atlassian.net');
      if (
        url.protocol !== 'https:' ||
        !isAtlassian ||
        url.username ||
        url.password ||
        hasExplicitPort ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Jira URL must be an HTTPS atlassian.net origin'
        });
        return z.NEVER;
      }
      return url.origin;
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Jira URL must be an HTTPS atlassian.net origin'
      });
      return z.NEVER;
    }
  });

export const secretMutationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('keep') }).strict(),
  z.object({ operation: z.literal('clear') }).strict(),
  z
    .object({
      operation: z.literal('set'),
      value: z
        .string()
        .trim()
        .min(1)
        .max(16_384)
        .refine(value => !/[\r\n]/u.test(value), {
          message: 'Credential must be a single line'
        })
    })
    .strict()
]);
export type SecretMutation = z.infer<typeof secretMutationSchema>;

export const projectCredentialsInteractionPayloadSchema = z
  .object({
    projectId: bbProjectIdSchema,
    projectName: z.string(),
    linearTeamKey: z.string(),
    jiraBaseUrl: jiraBaseUrlSchema,
    jiraEmail: z.string(),
    linearCredentialConfigured: z.boolean(),
    jiraCredentialConfigured: z.boolean()
  })
  .strict();
export type ProjectCredentialsInteractionPayload = z.infer<
  typeof projectCredentialsInteractionPayloadSchema
>;

export const projectCredentialsInteractionResponseSchema = z
  .object({
    linearCredential: secretMutationSchema,
    jiraCredential: secretMutationSchema
  })
  .strict();
export type ProjectCredentialsInteractionResponse = z.infer<
  typeof projectCredentialsInteractionResponseSchema
>;
