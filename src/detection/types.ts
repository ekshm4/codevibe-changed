/**
 * Detection System Type Definitions
 * Core types for AI vs Manual code detection
 */

import { AIDetectionMethod, AIClassification } from '../types';

export { AIDetectionMethod, AIClassification };

export type DetectionConfidence = 'high' | 'medium' | 'low';

export interface AIDetectionResult {
  isAI: boolean;
  confidence: DetectionConfidence;
  method: AIDetectionMethod;
  classification?: AIClassification;
  metadata: {
    source?: string;
    charactersCount: number;
    linesOfCode: number;
    timestamp: number;
    velocity?: number; // chars/second (for velocity method)
  };
}

export interface ManualDetectionResult {
  isManual: boolean;
  confidence: DetectionConfidence;
  characteristics: {
    singleCharTyping: boolean;    // 1 char per change
    gradualEditing: boolean;       // <100 chars per change
    activeFocus: boolean;          // File is open and focused
    humanSpeed: boolean;           // 20-500ms between keypresses
  };
  metadata: {
    charactersCount: number;
    linesOfCode: number;
    timestamp: number;
  };
}

export interface CodeChangeEvent {
  text: string;
  rangeLength: number;
  timestamp: number;
  documentUri: string;
  isActiveEditor: boolean;
}

export interface TypingEvent {
  timestamp: number;
  chars: number;
}
