import Foundation

public protocol EmbeddingProvider {
    var providerID: String { get }
    func embed(texts: [String]) throws -> [[Float]]
}

public protocol VectorStoreProvider {
    var providerID: String { get }
    func upsert(entityType: String, entityID: String, vector: [Float]) throws
    func search(vector: [Float], topK: Int) throws -> [String]
    func delete(entityType: String, entityID: String) throws
    func rebuild() throws
}

public protocol ObjectStorageProvider {
    var providerID: String { get }
    func put(path: String, data: Data) throws
    func get(path: String) throws -> Data
    func delete(path: String) throws
}

public protocol LLMProvider {
    var providerID: String { get }
    func chat(question: String, context: [String]) throws -> String
}

public struct ProviderRuntime {
    public var embedding: EmbeddingProvider
    public var vectorStore: VectorStoreProvider
    public var objectStorage: ObjectStorageProvider
    public var llm: LLMProvider?

    public init(
        embedding: EmbeddingProvider,
        vectorStore: VectorStoreProvider,
        objectStorage: ObjectStorageProvider,
        llm: LLMProvider?
    ) {
        self.embedding = embedding
        self.vectorStore = vectorStore
        self.objectStorage = objectStorage
        self.llm = llm
    }
}
