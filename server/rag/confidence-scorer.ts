import type { RemediationTemplate } from './template-loader';

/**
 * Calculate confidence score for a remediation template match
 */
export function calculateConfidence(
  checkId: string,
  template: RemediationTemplate,
  similarityScore: number
): number {
  let confidence = similarityScore; // Start with similarity score (0.0 - 1.0)

  // Boost if exact check ID match
  if (template.check_id === checkId) {
    confidence += 0.2;
  }

  // Boost if template is marked as tested
  if (template.confidence_factors?.tested) {
    confidence += 0.1;
  }

  // Boost if template has exact match flag
  if (template.confidence_factors?.exact_match) {
    confidence += 0.05;
  }

  // Penalize if similarity is very low
  if (similarityScore < 0.3) {
    confidence -= 0.2;
  }

  // Cap at 1.0
  confidence = Math.min(confidence, 1.0);
  confidence = Math.max(confidence, 0.0); // Ensure non-negative

  return confidence;
}

/**
 * Get confidence level category
 */
export function getConfidenceLevel(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

