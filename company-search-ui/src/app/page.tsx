/**
 * Next.js Data Search Page
 *
 * This component acts as the main client-side application for uploading an Excel
 * file and performing keyword searches against a FastAPI backend.
 *
 * It uses the "use client" directive to enable hooks (useState, useEffect).
 */
"use client";

import React, { useState, useCallback, useMemo } from "react";
import { Download, Search, Upload, Loader2, ServerOff } from "lucide-react";
// Removed the problematic 'next/font/google' import
// import { Inter } from 'next/font/google';

// Fallback font setup: using a Tailwind class that defaults to a sans-serif stack
// const inter = Inter({ subsets: ['latin'] });

// --- Types ---
interface SearchResult {
  keyword_results: {
    [sheetName: string]: {
      columns: string[];
      data: (string | number)[][];
    };
  };
  keyword_summary: {
    total_matches: number;
    sheet_counts: { [sheetName: string]: number };
  };
}

interface SheetResult {
  columns: string[];
  data: (string | number)[][];
}

// --- Constants ---
// API endpoint for the FastAPI backend (Must be running on localhost:8000)
const API_BASE_URL = "http://localhost:8000/api/search";

// --- Utility Functions ---

/**
 * Creates a Blob URL for a combined CSV download.
 * CSV format: _sheet, col1, col2, ...
 */
const createCombinedCsvBlob = (results: SearchResult): string | null => {
  // Use a null check on keyword_results inside the function for safety
  if (
    !results.keyword_results ||
    Object.keys(results.keyword_results).length === 0
  ) {
    return null;
  }

  const allRows: string[] = [];
  let headerWritten = false;

  for (const sheetName in results.keyword_results) {
    const sheetResult = results.keyword_results[sheetName];
    if (sheetResult.data.length === 0) continue;

    const columns = ["_sheet", ...sheetResult.columns];

    if (!headerWritten) {
      allRows.push(
        columns.map((col) => `"${col.replace(/"/g, '""')}"`).join(",")
      );
      headerWritten = true;
    }

    sheetResult.data.forEach((row) => {
      // Prepend sheet name to each data row
      const taggedRow = [sheetName, ...row];
      const csvLine = taggedRow
        .map((value) => {
          // Handle null/undefined/empty string values
          if (value === null || value === undefined || value === "")
            return '""';
          // Basic CSV sanitation for strings
          const stringValue = String(value).replace(/"/g, '""');
          return `"${stringValue}"`;
        })
        .join(",");
      allRows.push(csvLine);
    });
  }

  if (allRows.length <= 1) return null; // Only header or empty

  const csvContent = allRows.join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  return URL.createObjectURL(blob);
};

// --- Sub-Components ---

/**
 * Formats a cell value, applying a subtle highlight to the search term if found.
 */
const formatCellValue = (
  value: string | number,
  searchTerm: string
): string => {
  const text = String(value);
  if (!searchTerm) return text;

  // Escape special regex characters in the search term
  const escapedSearchTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escapedSearchTerm})`, "gi");

  // Replace matches with a styled span for subtle highlighting
  const highlightedHtml = text.replace(
    regex,
    '<span class="bg-blue-600/60 rounded-sm font-semibold text-white/90 px-1 py-0.5">$1</span>'
  );

  return highlightedHtml;
};

/**
 * Displays a single search result table for one sheet.
 */
const ResultCard: React.FC<{
  sheetName: string;
  result: SheetResult;
  query: string;
}> = ({ sheetName, result, query }) => {
  const { columns, data } = result;

  if (!data || data.length === 0) return null;

  return (
    // Updated background and shadow for more depth
    <div className="bg-gray-800/70 p-4 rounded-2xl shadow-xl mt-4 border border-gray-700/50">
      <h3 className="text-xl font-bold text-cyan-400 mb-4">
        {sheetName}{" "}
        <span className="text-gray-400 text-base font-normal">
          ({data.length} results)
        </span>
      </h3>
      <div className="overflow-x-auto max-h-[400px]">
        <table className="min-w-full text-sm text-left text-gray-300">
          <thead className="text-xs uppercase bg-cyan-800/30 text-cyan-200 sticky top-0 backdrop-blur-sm">
            <tr>
              {columns.map((col, index) => (
                <th
                  key={index}
                  scope="col"
                  className="px-6 py-3 border-r border-gray-700 last:border-r-0"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                // Stronger hover effect and alternating colors
                className="border-b border-gray-700 hover:bg-cyan-900/40 transition duration-150 ease-in-out odd:bg-gray-800/80 even:bg-gray-800/40"
              >
                {row.map((cellValue, cellIndex) => (
                  <td key={cellIndex} className="px-6 py-3 whitespace-nowrap">
                    <div
                      dangerouslySetInnerHTML={{
                        __html: formatCellValue(cellValue, query),
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// --- Main Component ---

// NEW: Use a structured empty object for initial state to prevent render errors
const INITIAL_RESULTS: SearchResult = {
  keyword_results: {},
  keyword_summary: {
    total_matches: 0,
    sheet_counts: {},
  },
};

const DataSearchApp: React.FC = () => {
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult>(INITIAL_RESULTS);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState(
    "Awaiting file upload and search query."
  );
  const [apiError, setApiError] = useState(false);

  // Memoize the combined CSV file
  const csvBlobUrl = useMemo(() => createCombinedCsvBlob(results), [results]);

  const handleSearch = useCallback(async () => {
    if (!excelFile) {
      setStatusMessage("Please upload an Excel file first.");
      return;
    }
    if (!query.trim()) {
      setStatusMessage("Please enter a search query.");
      return;
    }

    setLoading(true);
    // Reset state to initial empty structure instead of null
    setResults(INITIAL_RESULTS);
    setApiError(false);
    setStatusMessage("Searching...");

    const formData = new FormData();
    formData.append("file", excelFile);
    formData.append("query", query.trim());
    formData.append("use_semantic", "false");

    try {
      const response = await fetch(API_BASE_URL, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        setApiError(true);
        // Display HTTP status text for better debugging
        setStatusMessage(
          `Error communicating with API: ${response.status} ${
            response.statusText || "Not Found"
          }. Check server console.`
        );
        console.error("API Error Response:", response);
        return;
      }

      const data: SearchResult = await response.json();

      // STRICT CHECK: Ensure required fields are present and valid objects/numbers
      if (
        !data?.keyword_results ||
        typeof data.keyword_summary?.total_matches !== "number"
      ) {
        setStatusMessage(
          "API returned unexpected or malformed search results structure."
        );
        console.error("Malformed API response:", data);
        return;
      }

      setResults(data); // Safely set the new, valid data

      const sheetNames = Object.keys(data.keyword_results);
      if (data.keyword_summary.total_matches > 0) {
        setStatusMessage(
          `Found ${data.keyword_summary.total_matches} total matches across ${sheetNames.length} sheet(s).`
        );
      } else {
        setStatusMessage(`No keyword matches found for "${query.trim()}".`);
      }
    } catch (error) {
      setApiError(true);
      // More explicit instruction for the user to check their local server
      setStatusMessage(
        "Error communicating with API: Connection Refused. Make sure your FastAPI server is running on http://localhost:8000."
      );
      console.error("Fetch error:", error);
    } finally {
      setLoading(false);
    }
  }, [excelFile, query]);

  const handleDownload = useCallback(() => {
    if (csvBlobUrl) {
      const link = document.createElement("a");
      link.href = csvBlobUrl;
      link.setAttribute("download", "combined_search_results.csv");
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  }, [csvBlobUrl]);

  return (
    // Removed specific font class from here, relying on default sans-serif (Inter/system)
    <div className={`min-h-screen p-4 sm:p-8 text-white bg-gray-900 font-sans`}>
      <header className="py-6 border-b border-cyan-600/50 mb-8">
        <h1 className="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 to-blue-400 tracking-tight">
          Enterprise Data Search Engine{" "}
          <span className="text-xl font-medium text-gray-400">
            | From ten tables to ten million records — find it fast.
          </span>
        </h1>
      </header>

      <main className="max-w-7xl mx-auto">
        {/* --- Loading & Search Section --- */}
        <div className="bg-gray-800/90 p-6 rounded-2xl shadow-2xl backdrop-blur-sm border border-gray-700/50 mb-8 space-y-4">
          <h2 className="text-2xl font-semibold text-white mb-4">
            1. Load Data & Search
          </h2>

          <div className="flex flex-col sm:flex-row gap-4 items-end">
            {/* File Upload */}
            <div className="flex-1 w-full">
              <label
                htmlFor="file-upload"
                className="block text-sm font-medium text-gray-300 mb-2"
              >
                Excel Workbook (.xlsx)
              </label>
              <input
                id="file-upload"
                type="file"
                accept=".xlsx"
                onChange={(e) => {
                  if (e.target.files) {
                    setExcelFile(e.target.files[0]);
                    setResults(INITIAL_RESULTS); // Reset to empty structure
                    setStatusMessage(
                      `File loaded: ${e.target.files[0].name}. Ready to search.`
                    );
                  }
                }}
                className="block w-full text-sm text-gray-300
                   file:mr-4 file:py-2 file:px-4
                   file:rounded-full file:border-0
                   file:text-sm file:font-semibold
                   file:bg-cyan-500 file:text-white
                   hover:file:bg-cyan-600 cursor-pointer
                   bg-gray-700/50 rounded-lg p-2 transition duration-200"
              />
              {excelFile && (
                <p className="mt-1 text-xs text-gray-400">
                  Current file: {excelFile.name} (
                  {(excelFile.size / 1024 / 1024).toFixed(2)} MB)
                </p>
              )}
            </div>

            {/* Query Input */}
            <div className="flex-2 w-full sm:w-2/3">
              <label
                htmlFor="query"
                className="block text-sm font-medium text-gray-300 mb-2"
              >
                Search Query (Keyword/ID)
              </label>
              <input
                id="query"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                // Placeholder is now clean:
                placeholder="Enter keyword or unique identifier to search..."
                className="w-full p-3 bg-gray-700/50 border border-gray-600 rounded-lg text-white
                   focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 outline-none
                   transition duration-200 shadow-inner"
              />
            </div>

            {/* Search Button */}
            <button
              onClick={handleSearch}
              disabled={loading || !excelFile || !query.trim()}
              className="w-full sm:w-auto px-6 py-3 text-sm font-bold rounded-lg
                 bg-cyan-600 text-white shadow-lg shadow-cyan-600/50
                 hover:bg-cyan-700 transition duration-300 ease-in-out
                 disabled:bg-gray-600 disabled:shadow-none disabled:cursor-not-allowed
                 flex items-center justify-center gap-2 transform hover:scale-[1.02] active:scale-[0.98]"
            >
              {loading ? (
                <>
                  <Loader2 className="animate-spin w-5 h-5" /> Searching...
                </>
              ) : (
                <>
                  <Search className="w-5 h-5" /> Search
                </>
              )}
            </button>
          </div>
        </div>

        {/* --- Status & Summary --- */}
        {/* Adjusted colors for better contrast and visibility */}
        <div
          className={`p-4 rounded-xl mb-8 transition duration-300 font-medium ${
            apiError
              ? "bg-red-800/70 border-2 border-red-500 text-red-200"
              : "bg-gray-800/80 border-2 border-cyan-600/50 text-cyan-300"
          }`}
        >
          {statusMessage}
          {apiError && <ServerOff className="inline ml-2 w-5 h-5" />}
        </div>

        {/* --- Results Section (Keyword) --- */}
        <div className="mt-10">
          <h2 className="text-3xl font-bold text-white mb-6 flex justify-between items-center">
            Keyword Search Results
            {csvBlobUrl && (
              <button
                onClick={handleDownload}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-emerald-600 text-white
                     hover:bg-emerald-700 transition duration-300 shadow-md shadow-emerald-600/30 flex items-center gap-2 transform hover:scale-[1.02] active:scale-[0.98]"
              >
                <Download className="w-4 h-4" /> Download Combined CSV
              </button>
            )}
          </h2>

          <div className="grid grid-cols-1 gap-6">
            {Object.keys(results.keyword_results)
              .sort()
              .map((sheetName) => (
                <ResultCard
                  key={sheetName}
                  sheetName={sheetName}
                  result={results.keyword_results[sheetName]}
                  query={query.trim()}
                />
              ))}
          </div>

          {/* Check if we have received a result set (total_matches > 0) */}
          {results.keyword_summary.total_matches === 0 && !loading && (
            <div className="text-gray-400 text-lg p-6 text-center border border-gray-700 rounded-xl bg-gray-800/50">
              No results found in any sheet for "{query.trim()}".
            </div>
          )}
        </div>
      </main>

      <footer className="text-center mt-12 py-4 border-t border-gray-700/50 text-gray-500 text-sm">
        Powered by Next.js and FastAPI
      </footer>
    </div>
  );
};

export default DataSearchApp;
