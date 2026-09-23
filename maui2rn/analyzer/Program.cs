using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

if (args.Length != 1 || !Directory.Exists(args[0])) { Console.Error.WriteLine("Usage: MauiRoslyn <root>"); return 2; }
var root = Path.GetFullPath(args[0]);
var files = Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
  .Where(p => !p.Split(Path.DirectorySeparatorChar).Any(s => s is "bin" or "obj" or "node_modules" or ".git"))
  .OrderBy(p => p, StringComparer.Ordinal).Take(10001).ToArray();
if (files.Length > 10000) { Console.Error.WriteLine("Too many C# files"); return 2; }
var trees = new List<SyntaxTree>();
foreach (var file in files) {
  if (new FileInfo(file).Length > 2_000_000) { Console.Error.WriteLine($"File too large: {file}"); return 2; }
  trees.Add(CSharpSyntaxTree.ParseText(File.ReadAllText(file), path: file));
}

// This compilation resolves types declared in the source tree without MAUI workloads.
// External assembly types retain their syntax spelling when unavailable.
var runtime = ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "")
  .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
  .Select(p => MetadataReference.CreateFromFile(p)).ToArray();
var semanticAvailable = trees.Count <= 2500;
var compilation = semanticAvailable
  ? CSharpCompilation.Create("Maui2RnAnalysis", trees, runtime, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
  : null;
var classes = new List<object>();
foreach (var tree in trees) {
  var semantic = compilation?.GetSemanticModel(tree, ignoreAccessibility: true);
  var syntax = tree.GetRoot();
  foreach (var c in syntax.DescendantNodes().OfType<ClassDeclarationSyntax>()) {
    var symbol = semantic?.GetDeclaredSymbol(c);
    var ns = c.Ancestors().OfType<BaseNamespaceDeclarationSyntax>().Select(n => n.Name.ToString()).Reverse();
    var properties = new List<object>();
    foreach (var p in c.Members.OfType<PropertyDeclarationSyntax>()) {
      var ps = semantic?.GetDeclaredSymbol(p);
      var type = ps?.Type.TypeKind == TypeKind.Error ? p.Type.ToString() : ps?.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) ?? p.Type.ToString();
      var item = (ps?.Type as INamedTypeSymbol)?.TypeArguments.FirstOrDefault();
      var key = item?.GetMembers().OfType<IPropertySymbol>().FirstOrDefault(x => x.Name == "Id" || x.GetAttributes().Any(a => a.AttributeClass?.Name is "KeyAttribute" or "Key"));
      properties.Add(new {
        name = p.Identifier.Text, type, sourceKind = "declared", itemType = item?.TypeKind == TypeKind.Error ? null : item?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
        itemKey = key?.Name, attributes = Attributes(p.AttributeLists), validation = Validation(p.AttributeLists), semanticResolved = ps is not null && ps.Type.TypeKind != TypeKind.Error
      });
    }
    foreach (var f in c.Members.OfType<FieldDeclarationSyntax>()) {
      if (!Attributes(f.AttributeLists).Any(a => a.EndsWith("ObservableProperty", StringComparison.Ordinal) || a.EndsWith("ObservablePropertyAttribute", StringComparison.Ordinal))) continue;
      foreach (var variable in f.Declaration.Variables) {
        var stem = variable.Identifier.Text.TrimStart('_');
        if (stem.Length == 0) continue;
        var fs = semantic?.GetDeclaredSymbol(variable) as IFieldSymbol;
        var type = fs?.Type.TypeKind == TypeKind.Error ? f.Declaration.Type.ToString() : fs?.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) ?? f.Declaration.Type.ToString();
        properties.Add(new { name = char.ToUpperInvariant(stem[0]) + stem[1..], type, sourceKind = "observableField", itemType = (string?)null, itemKey = (string?)null,
          attributes = Attributes(f.AttributeLists), validation = Validation(f.AttributeLists), semanticResolved = fs is not null && fs.Type.TypeKind != TypeKind.Error });
      }
    }
    var methods = c.Members.OfType<MethodDeclarationSyntax>().Select(m => {
      var ms = semantic?.GetDeclaredSymbol(m);
      return new { name = m.Identifier.Text, returnType = ms?.ReturnType.TypeKind == TypeKind.Error ? m.ReturnType.ToString() : ms?.ReturnType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) ?? m.ReturnType.ToString(),
        parameters = m.ParameterList.Parameters.Select(p => new { name = p.Identifier.Text, type = p.Type?.ToString() ?? "object" }).ToArray(), attributes = Attributes(m.AttributeLists) };
    }).ToArray();
    var commands = c.Members.OfType<MethodDeclarationSyntax>()
      .Where(m => Attributes(m.AttributeLists).Any(a => a.EndsWith("RelayCommand", StringComparison.Ordinal) || a.EndsWith("RelayCommandAttribute", StringComparison.Ordinal)))
      .Select(m => {
        var methodName = m.Identifier.Text;
        var stem = methodName.EndsWith("Async", StringComparison.Ordinal) ? methodName[..^5] : methodName;
        var actions = Actions(m);
        var otherCalls = m.DescendantNodes().OfType<InvocationExpressionSyntax>().Any(i => !i.Expression.ToString().EndsWith("GoToAsync", StringComparison.Ordinal));
        var complexControl = m.DescendantNodes().Any(n => n is IfStatementSyntax or ForStatementSyntax or ForEachStatementSyntax or WhileStatementSyntax or TryStatementSyntax or ThrowStatementSyntax);
        var statements = m.Body?.Statements.ToArray() ?? (m.ExpressionBody is null ? Array.Empty<StatementSyntax>() : new StatementSyntax[] { SyntaxFactory.ExpressionStatement(m.ExpressionBody.Expression) });
        var simpleStatements = statements.Length == actions.Length && statements.All(s => s is ExpressionStatementSyntax expression &&
          (expression.Expression is InvocationExpressionSyntax invocation && invocation.Expression.ToString().EndsWith("GoToAsync", StringComparison.Ordinal)
           || expression.Expression is AwaitExpressionSyntax awaited && awaited.Expression is InvocationExpressionSyntax awaitedCall && awaitedCall.Expression.ToString().EndsWith("GoToAsync", StringComparison.Ordinal)
           || expression.Expression is AssignmentExpressionSyntax assignment &&
             (assignment.Right is LiteralExpressionSyntax || assignment.Left.ToString() == "_" && assignment.Right is InvocationExpressionSyntax discarded && discarded.Expression.ToString().EndsWith("GoToAsync", StringComparison.Ordinal))));
        return new { name = stem + "Command", method = methodName, actions,
          supported = actions.Length > 0 && simpleStatements && !otherCalls && !complexControl && m.ParameterList.Parameters.Count == 0 };
      }).ToArray();
    var navigation = c.DescendantNodes().OfType<InvocationExpressionSyntax>()
      .Where(i => i.Expression.ToString().Contains("GoToAsync") || i.Expression.ToString().Contains("RegisterRoute"))
      .Select(i => i.ToString()).Take(100).ToArray();
    var registrations = c.DescendantNodes().OfType<InvocationExpressionSyntax>()
      .Where(i => i.Expression.ToString().Contains("AddSingleton") || i.Expression.ToString().Contains("AddTransient") || i.Expression.ToString().Contains("AddScoped"))
      .Select(i => i.ToString()).Take(100).ToArray();
    var httpCalls = c.DescendantNodes().OfType<InvocationExpressionSyntax>()
      .Select(HttpCall).Where(i => i is not null).Take(100).ToArray();
    var dependencies = c.Members.OfType<ConstructorDeclarationSyntax>().SelectMany(con => con.ParameterList.Parameters)
      .Select(p => p.Type?.ToString() ?? "object").Distinct().ToArray();
    classes.Add(new {
      name = c.Identifier.Text, @namespace = symbol?.ContainingNamespace.ToDisplayString() ?? string.Join('.', ns),
      source = Path.GetRelativePath(root, tree.FilePath).Replace('\\','/'),
      bases = c.BaseList?.Types.Select(t => t.Type.ToString()).ToArray() ?? Array.Empty<string>(),
      properties, methods, commands, navigation, registrations, httpCalls, dependencies,
      attributes = Attributes(c.AttributeLists), semanticResolved = symbol is not null
    });
  }
}
Console.WriteLine(JsonSerializer.Serialize(new { analysisMode = semanticAvailable ? "semantic" : "syntax", classes }));
return 0;

static string[] Attributes(SyntaxList<AttributeListSyntax> lists) => lists.SelectMany(a => a.Attributes).Select(a => a.Name.ToString()).ToArray();
static object[] Validation(SyntaxList<AttributeListSyntax> lists) => lists.SelectMany(a => a.Attributes).Select(a => new {
  kind = a.Name.ToString().Replace("Attribute", ""), argument = a.ArgumentList?.Arguments.FirstOrDefault()?.Expression.ToString().Trim('"')
}).Where(a => a.kind is "Required" or "MinLength" or "MaxLength" or "Range" or "EmailAddress").Cast<object>().ToArray();
static ActionInfo[] Actions(MethodDeclarationSyntax method) => method.DescendantNodes().OfType<ExpressionSyntax>().Select(e => {
  if (e is InvocationExpressionSyntax call && call.Expression.ToString().EndsWith("GoToAsync", StringComparison.Ordinal)) {
    var route = call.ArgumentList.Arguments.FirstOrDefault()?.Expression as LiteralExpressionSyntax;
    if (route?.IsKind(SyntaxKind.StringLiteralExpression) == true) return new ActionInfo("navigate", "", route.Token.ValueText, "route");
  }
  if (e is AssignmentExpressionSyntax assignment && assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)) {
    if (assignment.Right is LiteralExpressionSyntax literal) {
      var valueType = literal.Kind() switch {
        SyntaxKind.StringLiteralExpression => "string",
        SyntaxKind.NumericLiteralExpression => "number",
        SyntaxKind.TrueLiteralExpression or SyntaxKind.FalseLiteralExpression => "boolean",
        SyntaxKind.NullLiteralExpression => "null",
        _ => "unsupported"
      };
      if (valueType != "unsupported") return new ActionInfo("set", assignment.Left.ToString(), literal.Token.ValueText, valueType);
    }
  }
  return null;
}).Where(a => a is not null).Distinct().Take(50).Cast<ActionInfo>().ToArray();
static object? HttpCall(InvocationExpressionSyntax call) {
  var method = call.Expression is MemberAccessExpressionSyntax access ? access.Name.Identifier.Text : call.Expression.ToString().Split('.').Last();
  var verb = method switch { "GetStringAsync" or "GetFromJsonAsync" or "GetAsync" => "GET", "PostAsJsonAsync" or "PostAsync" => "POST", "PutAsJsonAsync" or "PutAsync" => "PUT", "DeleteAsync" => "DELETE", _ => null };
  if (verb is null) return null;
  var first = call.ArgumentList.Arguments.FirstOrDefault()?.Expression as LiteralExpressionSyntax;
  if (first?.IsKind(SyntaxKind.StringLiteralExpression) != true) return null;
  return new { verb, url = first.Token.ValueText, method, owner = call.Ancestors().OfType<MethodDeclarationSyntax>().FirstOrDefault()?.Identifier.Text };
}
record ActionInfo(string kind, string target, string value, string valueType);
