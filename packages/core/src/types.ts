export interface SearchQuery {
    term: string;
    includeContent?: boolean;
    limit?: number;
}

export interface SemanticSearchResult {
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    score: number;
    /**
     * The chunk's stored dense embedding. Only populated when the search was
     * asked to return vectors (org-wide search uses it to re-rank across
     * collections); stripped before results are returned to callers.
     */
    vector?: number[];
}

export interface OrgSearchResult extends SemanticSearchResult {
    collectionName: string;
    repo?: string;
    codebasePath?: string;
}
