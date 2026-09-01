import { LanguageManager } from './LanguageManager';

async function test() {
    const manager = LanguageManager.getInstance();
    await manager.init();

    // Test JS
    console.log('Testing JavaScript...');
    const jsParser = await manager.getParser('javascript');
    
    if (jsParser) {
        const jsTree = jsParser.parse('function test() { return 1; }');
        console.log('✅ JS Root Node:', jsTree.rootNode.type);
    } else {
        console.error('❌ Failed to create JS Parser (WASM missing)');
    }

    // Test Python
    console.log('Testing Python...');
    try {
        const pyParser = await manager.getParser('python');
        const pyTree = pyParser.parse('def foo(): pass');
        
        // Use ?. here as well
        console.log('✅ Python Root Node:', pyTree?.rootNode.type);
    } catch (e) {
        console.log("❌ Python WASM not found. (We likely need to download the .wasm file manually)");
    }
}

test().catch(console.error);