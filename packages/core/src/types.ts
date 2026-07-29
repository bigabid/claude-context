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
}

export interface OrgSearchResult extends SemanticSearchResult {
    collectionName: string;
    repo?: string;
    codebasePath?: string;
}
