import {
  convertFileToPdf,
  convertPdfToImages,
  downloadFile,
  formatMarkdown,
  isString,
  validateLLMParams
} from "./utils";
import fs from "fs-extra";
import os from "os";
import path from "path";
import pLimit, { Limit } from "p-limit";
import {
  DocumindArgs,
  DocumindOutput,
  ModelOptions,
  OpenAIModels,
} from "./types";
import { getModel } from "./providers";
import { Completion } from "./providers/utils/completion";

export const documind = async ({
  cleanup = true,
  concurrency = 10,
  filePath,
  llmParams = {},
  maintainFormat = false,
  model, //= ModelOptions.gpt_4o_mini,
  outputDir,
  pagesToConvertAsImages = -1,
  tempDir = os.tmpdir(),
}: DocumindArgs): Promise<DocumindOutput> => {

  let inputTokenCount = 0;
  let outputTokenCount = 0;
  let priorPage = "";
  const aggregatedMarkdown: string[] = [];
  const startTime = new Date();

  // Basic checks
  if (!filePath || !filePath.length) {
    throw new Error("Missing file path");
  }

  const defaultModel: ModelOptions = model ?? OpenAIModels.GPT_4O_MINI;

  const validatedParams = validateLLMParams(llmParams);

  const providerInstance: Completion = getModel.getProviderForModel(defaultModel);

  // Ensure temp directory exists + create temp folder
  const rand = Math.floor(1000 + Math.random() * 9000).toString();
  const tempDirectory = path.join(tempDir || os.tmpdir(), `documind-file-${rand}`);
  await fs.ensureDir(tempDirectory);

  // Download the PDF. Get file name.
  const { extension, localPath } = await downloadFile({
    filePath,
    tempDir: tempDirectory,
  });
  if (!localPath) throw "Failed to save file to local drive";

  // Sort the `pagesToConvertAsImages` array to make sure we use the right index
  // for `formattedPages` as `pdf2pic` always returns images in order
  if (Array.isArray(pagesToConvertAsImages)) {
    pagesToConvertAsImages.sort((a, b) => a - b);
  }

  // Convert file to PDF if necessary
  if (extension !== ".png") {
    let pdfPath: string;
    if (extension === ".pdf") {
      pdfPath = localPath;
    } else {
      pdfPath = await convertFileToPdf({
        extension,
        localPath,
        tempDir: tempDirectory,
      });
    }
    // Convert the file to a series of images
    await convertPdfToImages({
      localPath: pdfPath,
      pagesToConvertAsImages,
      tempDir: tempDirectory,
    });
  }

  const endOfPath = localPath.split("/")[localPath.split("/").length - 1];
  const rawFileName = endOfPath.split(".")[0];
  const fileName = rawFileName
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, "_")
    .toLowerCase()
    .substring(0, 255); // Truncate file name to 255 characters to prevent ENAMETOOLONG errors

  // Get list of converted images
  const files = await fs.readdir(tempDirectory);
  const images = files.filter((file) => file.endsWith(".png"));

  if (maintainFormat) {
    // Use synchronous processing
    for (const image of images) {
      const imagePath = path.join(tempDirectory, image);
      try {
        const { content, inputTokens, outputTokens } = await providerInstance.getCompletion({
          imagePath,
          llmParams: validatedParams,
          maintainFormat,
          model: defaultModel,
          priorPage,
        });
        const formattedMarkdown = formatMarkdown(content);
        inputTokenCount += inputTokens;
        outputTokenCount += outputTokens;

        // Update prior page to result from last processing step
        priorPage = formattedMarkdown;

        // Add all markdown results to array
        aggregatedMarkdown.push(formattedMarkdown);
      } catch (error) {
        console.error(`Failed to process image ${image}:`, error);
        throw error;
      }
    }
  } else {
    // Process in parallel with a limit on concurrent pages
    const processPage = async (image: string): Promise<string | null> => {
      const imagePath = path.join(tempDirectory, image);
      try {
        const { content, inputTokens, outputTokens } = await providerInstance.getCompletion({
          imagePath,
          llmParams: validatedParams,
          maintainFormat,
          model: defaultModel,
          priorPage,
        });
        const formattedMarkdown = formatMarkdown(content);
        inputTokenCount += inputTokens;
        outputTokenCount += outputTokens;

        // Update prior page to result from last processing step
        priorPage = formattedMarkdown;

        // Add all markdown results to array
        return formattedMarkdown;
      } catch (error) {
        console.error(`Failed to process image ${image}:`, error);
        throw error;
      }
    };

    // Function to process pages with concurrency limit
    const processPagesInBatches = async (images: string[], limit: Limit) => {
      const results: (string | null)[] = [];

      const promises = images.map((image, index) =>
        limit(() =>
          processPage(image).then((result) => {
            results[index] = result;
          })
        )
      );

      await Promise.all(promises);
      return results;
    };

    const limit = pLimit(concurrency);
    const results = await processPagesInBatches(images, limit);
    const filteredResults = results.filter(isString);
    aggregatedMarkdown.push(...filteredResults);
  }

  // Write the aggregated markdown to a file
  if (outputDir) {
    const resultFilePath = path.join(outputDir, `${fileName}.md`);
    await fs.writeFile(resultFilePath, aggregatedMarkdown.join("\n\n"));
  }

  // Cleanup the downloaded PDF file
  if (cleanup) await fs.remove(tempDirectory);

  // Format JSON response
  const endTime = new Date();
  const completionTime = endTime.getTime() - startTime.getTime();
  const formattedPages = aggregatedMarkdown.map((el, i) => {
    let pageNumber;
    // If we convert all pages, just use the array index
    if (pagesToConvertAsImages === -1) {
      pageNumber = i + 1;
    }
    // Else if we convert specific pages, use the page number from the parameter
    else if (Array.isArray(pagesToConvertAsImages)) {
      pageNumber = pagesToConvertAsImages[i];
    }
    // Else, the parameter is a number and use it for the page number
    else {
      pageNumber = pagesToConvertAsImages;
    }

    return { content: el, page: pageNumber, contentLength: el.length };
  });

  return {
    completionTime,
    fileName,
    inputTokens: inputTokenCount,
    outputTokens: outputTokenCount,
    pages: formattedPages,
  };
};
