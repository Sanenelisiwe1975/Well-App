import path from "path";
import { parseDocument } from "./parseDocument.js";
import { getFraudDetectionPrompt } from "./llm/prompts";
import { getCurrentLLM } from "./llm/models";
import type { DocumentInput, DetectionResult } from "./types";
import {
  BaseError,
  ValidationError,
  AIServiceError,
  ProcessingError,
} from "../../../shared/errors/base.js";
import { ErrorCode, ErrorContext } from "../../../shared/errors/types.js";

export async function analyzeDocument(
  input: DocumentInput
): Promise<DetectionResult> {
  const context: ErrorContext = {
    operation: "analyzeDocument",
    module: "fraud-detector",
    timestamp: new Date().toISOString(),
    metadata: { inputType: input.type },
  };

  try {
    const parsedData = await parseDocument(input);
    const extractedText =
      parsedData.extracted_text || JSON.stringify(parsedData, null, 2);
    const metadata = parsedData.metadata || {};
    let is_fake = false;
    const indicators: DetectionResult["indicators"] = [];

    // 🔎 0. Rejet si document image/pdf sans signes de facture
    let fileExt = "";
    if (
      input.type === "file" &&
      "path" in input &&
      typeof input.path === "string"
    ) {
      fileExt = path.extname(input.path).toLowerCase();
    }

    const isImage = [".png", ".jpg", ".jpeg"].includes(fileExt);
    const isPDF = fileExt === ".pdf";
    const textContent = typeof extractedText === "string" ? extractedText : "";
    const keywords = [
      "invoice",
      "facture",
      "total",
      "payment",
      "receipt",
      "numéro",
      "commande",
      "prix",
      "amount",
    ];
    const containsInvoiceTerms = keywords.some((word) =>
      textContent.toLowerCase().includes(word)
    );

    if (
      (isImage || isPDF) &&
      (textContent.length < 200 || !containsInvoiceTerms)
    ) {
      return {
        is_fake: false,
        confidence: 0,
        indicators: [
          {
            category: "textual",
            value: "Unrecognized document type",
            description:
              "The document does not appear to contain a valid invoice or receipt.",
          },
        ],
      };
    }

    // 🔍 1. Heuristic check: Total vs item sum
    if (parsedData.total && Array.isArray(parsedData.items)) {
      const sum = parsedData.items.reduce(
        (acc, item) => acc + parseFloat(item.price || "0"),
        0
      );
      const declared = parseFloat(parsedData.total);

      if (Math.abs(sum - declared) > 0.01) {
        indicators.push({
          category: "textual",
          value: "invoice total does not match item sum",
          description: `Declared total is ${declared}, but sum of items is ${sum.toFixed(
            2
          )}`,
        });
        is_fake = true;
      }
    }

    // 🔍 2. Metadata check (heuristic)
    if (metadata.producer) {
      const suspiciousPatterns = ["ai", "generator", "fake", "synth"];
      const lowerProducer = metadata.producer.toLowerCase();

      if (
        suspiciousPatterns.some((pattern) => lowerProducer.includes(pattern))
      ) {
        indicators.push({
          category: "metadata",
          value: metadata.producer,
          description: "Suspicious PDF producer suggests AI-generated document",
        });
        is_fake = true;
      }
    }

    // 🧠 3. Prompt-based LLM analysis
    const metadataBlock = Object.entries(metadata)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n");

    const promptTemplate = await getFraudDetectionPrompt(extractedText);
    const finalPrompt = `${promptTemplate}
  
    ===== DOCUMENT TEXT =====
    ${extractedText}
  
    ===== METADATA =====
    ${metadataBlock || "None"}
    `;

    console.log("🧠 Prompt envoyé au modèle :\n", finalPrompt);

    const llmResult = await getCurrentLLM().generate(finalPrompt);

    // 🧮 4. Combine results (heuristics + LLM)
    const combined: DetectionResult = {
      is_fake: is_fake || llmResult.is_fake,
      confidence: Math.max(llmResult.confidence, is_fake ? 60 : 0),
      indicators: [...indicators, ...llmResult.indicators],
    };

    return combined;
  } catch (error) {
    if (error instanceof BaseError) {
      throw error;
    }
    throw new ProcessingError(
      "document analysis",
      context,
      (error as Error).message
    );
  }
}
